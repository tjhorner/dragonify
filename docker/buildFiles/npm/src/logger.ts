import { createLogger, format, transports } from "winston"

const RE: RegExp = /[^0-9]+/

function isArrayObject(o: object): boolean {
  const keys: string[] = Object.keys(o)
  if (keys.length === 0) {
    return false
  }
  if (keys.some(k => RE.test(k))) {
    return false
  }

  const intKeys: number[] = keys.map(k => parseInt(k, 10))
  if (Math.min(...intKeys) !== 0 || Math.max(...intKeys) !== intKeys.length - 1) {
    return false // keys not a sequence 0-n
  }

  return true
}

const consoleFormat = format.combine(
  format.errors({ stack: true }),
  format.printf((info) => {
    // Handle e.g. logger.info("message", object1, array2, number3)
    // Parameters after the message are parsed into an object "rest"
    // If this is effectively an array i.e. only has attributes "0", "1" etc.
    // then we convert it into an array for display, otherwise we leave it as a js object
    const {level, message, stack, ...rest} = info
    let meta: any[] | undefined = undefined
    if (isArrayObject(rest)) {
      meta = Object.values(
        Object.entries(rest)
        .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
        .map(d => d[1])
      )
    }
    return `${level}:\t${message}` +
      (Object.keys(rest).length > 0 ? (
        Array.isArray(meta) ? ` [${meta.toString()}]` : ` ${JSON.stringify(rest)}`
        ) : "") +
      (stack ? `\n${stack}` : "")
  })
)

const fileFormat = format.combine(
  format.timestamp({
    format: "YY-MM-DD HH:mm:ss"
  }),
  format.errors({ stack: true }),
  format.printf((info) => {
    // Handle e.g. logger.info("message", object1, array2, number3)
    // Parameters after the message are parsed into an object "rest"
    // If this is effectively an array i.e. only has attributes "0", "1" etc.
    // then we convert it into an array for display, otherwise we leave it as a js object
    const {timestamp, level, message, stack, ...rest} = info
    let meta: any[] | undefined = undefined
    if (isArrayObject(rest)) {
      meta = Object.values(
        Object.entries(rest)
        .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
        .map(d => d[1])
      )
    }
    return `${timestamp} ${level}:\t${message}` +
      (Object.keys(rest).length > 0 ? (
        Array.isArray(meta) ? ` [${meta.toString()}]` : ` ${JSON.stringify(rest)}`
        ) : "") +
      (stack ? `\n${stack}` : "")
  })
)

export const logger = createLogger({
  transports: [
    new transports.Console({
      level: process.env.LOG_LEVEL || "info",
      format: consoleFormat,
      handleRejections: true,
    }),
    new transports.File({
      filename: 'logs/dragonify-debug.log',
      level: 'debug',
      format: fileFormat,
      maxsize: 65536,
      maxFiles: 2,
      tailable: true,
      handleExceptions: true,
      handleRejections: true,
    }),
    new transports.File({
      filename: 'logs/dragonify-errors.log',
      level: 'error',
      format: fileFormat,
      lazy: true,
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
})
