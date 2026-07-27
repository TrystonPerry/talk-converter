const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type Level = keyof typeof LEVELS;

// --verbose is stripped from argv before the positional args are read, so it can
// sit anywhere on the command line.
const verbose =
  process.argv.includes("--verbose") ||
  process.env["LOG_LEVEL"]?.toLowerCase() === "debug";

const threshold = verbose ? LEVELS.debug : LEVELS.info;

// Respect the NO_COLOR convention, and drop colour when piped to a file.
const colored = !process.env["NO_COLOR"] && process.stdout.isTTY;

const paint = (code: string, text: string) =>
  colored ? `\x1b[${code}m${text}\x1b[0m` : text;

const dim = (text: string) => paint("2", text);

const STYLES: Record<Level | "step" | "done", { code: string; label: string }> =
  {
    debug: { code: "2", label: "DEBUG" },
    info: { code: "36", label: "INFO " },
    warn: { code: "33", label: "WARN " },
    error: { code: "31", label: "ERROR" },
    step: { code: "1;35", label: "STEP " },
    done: { code: "32", label: "DONE " },
  };

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

function emit(style: keyof typeof STYLES, level: Level, message: string) {
  if (LEVELS[level] < threshold) return;

  const { code, label } = STYLES[style];
  const stream = level === "error" || level === "warn" ? console.error : console.log;

  for (const line of message.split("\n")) {
    stream(`${dim(clock())} ${paint(code, label)} ${line}`);
  }
}

export const log = {
  verbose,

  debug: (message: string) => emit("debug", "debug", message),
  info: (message: string) => emit("info", "info", message),
  warn: (message: string) => emit("warn", "warn", message),
  error: (message: string) => emit("error", "error", message),
  done: (message: string) => emit("done", "info", message),

  // `marker` is a free-form progress label ("1/3", "Talk 2/5") because the
  // per-talk phases aren't counted until detection has run.
  step(marker: string, title: string) {
    console.log("");
    emit("step", "info", `[${marker}] ${title}`);
  },

  // Indented key/value line, for the supporting facts under a step.
  detail(key: string, value: string | number) {
    emit("info", "info", dim(`  ${key}: ${value}`));
  },
};

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// Times an async step and logs how long it took.
export async function timed<T>(label: string, work: () => Promise<T>) {
  const startedAt = performance.now();
  const result = await work();

  log.detail(`${label} took`, formatDuration(performance.now() - startedAt));

  return result;
}
