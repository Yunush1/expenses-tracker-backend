const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Where scanned receipt photos are kept, and what stops them being readable by
 * anybody who feels like looking.
 *
 * These files are served from a static directory with **no login** — they have to
 * be, because every member of a group can see the expense a photo belongs to and
 * most members have no account at all. So the filename is the credential, and this
 * file exists to assert the three properties that follow from that:
 *
 * 1. **Names are unguessable and never derived from anything.** 128 random bits,
 *    like an invite code. A name containing a group id, a member id or a counter
 *    would turn the directory into a browsable archive of other people's receipts.
 * 2. **Nothing a caller sends becomes part of a path.** The declared MIME type is
 *    untrusted input that ends up as a filename, and the only defence that holds is
 *    generating the name rather than accepting one.
 * 3. **The sweep never takes a photo an expense points at.** Retention bounds
 *    litter, not history: deleting the evidence behind a disputed line is the one
 *    thing this cleanup must not do.
 */

/** Load the storage module pointed at a throwaway directory. */
const withStorage = async (env, fn) => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-"));

  Object.assign(process.env, {
    MONGO_URI: "mongodb://localhost/test",
    RECEIPT_STORE_DIR: dir,
    ...env,
  });

  for (const key of Object.keys(require.cache)) {
    if (key.includes("config") || key.includes("receiptStorage")) delete require.cache[key];
  }

  try {
    return await fn(require("../src/utils/receiptStorage"), dir);
  } finally {
    process.env = saved;

    /**
     * Cleanup must not be able to fail the test.
     *
     * On Windows `rmSync` intermittently throws EBUSY or EPERM when a file was
     * written moments earlier — an indexer or a scanner still has it open — and
     * that failure surfaced as this whole file failing roughly one run in three,
     * with every assertion inside it passing. A leftover temp directory is the
     * operating system's problem; a flaky suite is everybody's.
     */
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS will reap it */
    }

    for (const key of Object.keys(require.cache)) {
      if (key.includes("config") || key.includes("receiptStorage")) delete require.cache[key];
    }
  }
};

const jpeg = (bytes = 64) =>
  `data:image/jpeg;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;

/* ------------------------------ 1. Names ---------------------------------- */

test("a stored photo gets a 128-bit random name", async () => {
  await withStorage({}, async (storage) => {
    const url = await storage.save(jpeg());

    // 32 hex characters is 16 bytes is 128 bits — the same order as an invite
    // code, and the entire reason an unauthenticated URL is safe to hand out.
    assert.match(url, /^\/uploads\/receipts\/[a-f0-9]{32}\.jpg$/);
  });
});

test("two photos never collide, and neither is derived from the other", async () => {
  await withStorage({}, async (storage) => {
    const urls = await Promise.all([jpeg(), jpeg(), jpeg(), jpeg(), jpeg()].map(storage.save));

    assert.equal(new Set(urls).size, 5, "names must be unique");

    // Identical bytes must still produce different names: a content hash would
    // make "did this group scan the same receipt as that one" answerable by
    // anybody holding one URL.
    const names = urls.map((url) => url.split("/").pop());
    assert.equal(new Set(names).size, 5);
  });
});

test("the extension comes from a fixed map, never from the caller", async () => {
  await withStorage({}, async (storage) => {
    assert.match(await storage.save(jpeg()), /\.jpg$/);
    assert.match(
      await storage.save(`data:image/png;base64,${Buffer.alloc(64, 1).toString("base64")}`),
      /\.png$/
    );
    assert.match(
      await storage.save(`data:image/webp;base64,${Buffer.alloc(64, 1).toString("base64")}`),
      /\.webp$/
    );
  });
});

/* --------------------------- 2. Untrusted input --------------------------- */

test("anything that is not one of three image types is refused", async () => {
  await withStorage({}, async (storage) => {
    for (const bad of [
      "",
      null,
      undefined,
      "not a data url",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:application/pdf;base64,AAAA",
      "data:image/svg+xml;base64,AAAA",
      // SVG is the interesting refusal: it is an image, and it can carry script.
      "data:image/gif;base64,AAAA",
    ]) {
      assert.equal(await storage.save(bad), null, `${JSON.stringify(bad)} must be refused`);
    }
  });
});

test("a path cannot be smuggled through the MIME type", async () => {
  await withStorage({}, async (storage, dir) => {
    for (const attack of [
      "data:image/../../etc/passwd;base64,AAAA",
      "data:image/jpeg/../../../evil;base64,AAAA",
      "data:image/jpeg;base64,AAAA/../../../evil",
    ]) {
      const url = await storage.save(attack);
      // Either refused outright, or written under a generated name — never a path.
      if (url !== null) assert.match(url, /^\/uploads\/receipts\/[a-f0-9]{32}\.(jpg|png|webp)$/);
    }

    // Nothing escaped the directory.
    const written = fs.readdirSync(dir);
    for (const name of written) {
      assert.match(name, /^[a-f0-9]{32}\.(jpg|png|webp)$/);
    }
  });
});

test("storage switched off writes nothing and says so", async () => {
  await withStorage({ RECEIPT_STORE_ENABLED: "false" }, async (storage, dir) => {
    assert.equal(await storage.save(jpeg()), null);
    assert.equal(fs.readdirSync(dir).length, 0);
    assert.equal(storage.isEnabled(), false);
  });
});

test("a full disk loses the photo, not the scan", async () => {
  await withStorage({ RECEIPT_STORE_DIR: "\0invalid" }, async (storage) => {
    // Never throws: the scan has already been paid for, and the numbers are the
    // valuable part. Losing the file silently is the right failure.
    assert.equal(await storage.save(jpeg()), null);
  });
});

/* ------------------------------ 3. The sweep ------------------------------ */

test("an unreferenced, old photo is swept", async () => {
  await withStorage({}, async (storage, dir) => {
    const url = await storage.save(jpeg());
    const name = url.split("/").pop();

    // Age it past the retention window.
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(dir, name), old / 1000, old / 1000);

    const result = await storage.sweep(new Set());

    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(dir, name)), false);
  });
});

test("THE RULE: a referenced photo is never swept, however old", async () => {
  await withStorage({}, async (storage, dir) => {
    const url = await storage.save(jpeg());
    const name = url.split("/").pop();

    // Two years old, and attached to an expense.
    const ancient = Date.now() - 730 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(dir, name), ancient / 1000, ancient / 1000);

    const result = await storage.sweep(new Set([name]));

    assert.equal(result.deleted, 0, "retention bounds litter, never history");
    assert.equal(result.kept, 1);
    assert.ok(fs.existsSync(path.join(dir, name)));
  });
});

test("a photo somebody is still reviewing is not swept out from under them", async () => {
  await withStorage({}, async (storage, dir) => {
    // Written seconds ago, referenced by nothing yet — a scan on screen right now.
    const url = await storage.save(jpeg());
    const result = await storage.sweep(new Set());

    assert.equal(result.deleted, 0);
    assert.ok(fs.existsSync(path.join(dir, url.split("/").pop())));
  });
});

test("sweeping an empty or missing directory is not an error", async () => {
  await withStorage({}, async (storage, dir) => {
    assert.deepEqual(await storage.sweep(new Set()), { deleted: 0, kept: 0 });

    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(await storage.sweep(new Set()), { deleted: 0, kept: 0 });
  });
});

/* ------------------------- URL → name, for the sweep ----------------------- */

test("only this server's own URLs resolve to a filename", async () => {
  await withStorage({}, async (storage) => {
    const good = "/uploads/receipts/0123456789abcdef0123456789abcdef.jpg";
    assert.equal(storage.nameFromUrl(good), "0123456789abcdef0123456789abcdef.jpg");

    for (const bad of [
      "",
      null,
      "https://evil.example.com/x.jpg",
      "/uploads/receipts/../../../etc/passwd",
      "/uploads/receipts/short.jpg",
      "/uploads/receipts/0123456789abcdef0123456789abcdef.exe",
      "/uploads/other/0123456789abcdef0123456789abcdef.jpg",
    ]) {
      assert.equal(storage.nameFromUrl(bad), null, `${JSON.stringify(bad)} must not resolve`);
    }
  });
});
