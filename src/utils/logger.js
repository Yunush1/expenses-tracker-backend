const path = require("path");
const { createLogger, format, transports } = require("winston");

const { combine, timestamp, printf, errors, colorize } = format;

const logDir = "logs";

const logFormat = printf(({ level, message, timestamp: ts, stack }) => {
  return `${ts} [${level}]: ${stack || message}`;
});

const logger = createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), errors({ stack: true })),
  transports: [
    new transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        logFormat
      ),
    }),

    new transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
      format: combine(timestamp(), errors({ stack: true }), logFormat),
    }),

    new transports.File({
      filename: path.join(logDir, "combined.log"),
      format: combine(timestamp(), errors({ stack: true }), logFormat),
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
