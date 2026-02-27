export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const levelWeights: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

const isLogLevel = (value: string): value is LogLevel =>
  value === "silent" ||
  value === "error" ||
  value === "warn" ||
  value === "info" ||
  value === "debug";

const resolveLevel = (level: string | undefined, fallback: LogLevel): LogLevel => {
  if (!level) {
    return fallback;
  }

  const normalized = level.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : fallback;
};

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export interface Logger {
  error(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

export const createLogger = (scope: string, level?: string, defaultLevel: LogLevel = "warn"): Logger => {
  const minLevel = resolveLevel(level, defaultLevel);

  const emit = (levelName: Exclude<LogLevel, "silent">, message: string, meta?: unknown): void => {
    if (levelWeights[levelName] > levelWeights[minLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${scope}] [${levelName}] ${message}`;

    if (meta === undefined) {
      if (levelName === "error") {
        console.error(prefix);
      } else if (levelName === "warn") {
        console.warn(prefix);
      } else {
        console.log(prefix);
      }
      return;
    }

    const withMeta = `${prefix} ${safeStringify(meta)}`;
    if (levelName === "error") {
      console.error(withMeta);
    } else if (levelName === "warn") {
      console.warn(withMeta);
    } else {
      console.log(withMeta);
    }
  };

  return {
    error: (message, meta) => emit("error", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    info: (message, meta) => emit("info", message, meta),
    debug: (message, meta) => emit("debug", message, meta)
  };
};
