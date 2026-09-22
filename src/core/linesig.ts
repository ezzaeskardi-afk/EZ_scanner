/**
 * What `ezscan doctor` measured about the line, kept for the scan that comes after it.
 *
 * The doctor closes by naming the preset this line needs, but the name only reaches the scan if
 * the user retypes it — so the flow the doctor exists for (`doctor`, then scan the line it just
 * diagnosed) quietly ran `standard` on a line the tool had already read. The measurement is
 * written next to the saved sessions and read back by the next scan, which applies it and says so.
 *
 * It expires, deliberately. What an operator does to a burst is not a property of the address; it
 * is a property of the hour — a line that caps sessions at noon can be generous at 3am — so a
 * day-old verdict is not evidence, and steering `--workers`/`--rate` with it would be the same
 * guessing the measurement exists to remove. Past the window the scan says the measurement is old
 * and names the one command that refreshes it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the measurement lives, beside the session folder the scanner already writes. */
const SIGNATURE_FILE = 'line-signature.json';

/** Schema version, so a future shape is rejected rather than misread. */
const SIGNATURE_VERSION = 1;

/**
 * How long a measurement may steer a scan.
 *
 * Twelve hours covers the flow this exists for — run `doctor`, then scan, including a scan started
 * the same evening — while staying short enough that the reading still describes the hour it is
 * used in. `test/line-signature.test.ts` pins that the boundary is enforced in both directions.
 */
export const SIGNATURE_TTL_MS = 12 * 60 * 60 * 1000;

export interface StoredSignature {
  version: typeof SIGNATURE_VERSION;
  /** When the measurement ran, in epoch milliseconds. */
  measuredAt: number;
  /** `--preset <name>`, or null when the line showed no operator-specific behaviour. */
  preset: string | null;
  /** One sentence per mechanism that matched, strongest first. */
  reasons: string[];
  /** The address the burst dialled, so a measurement can be recognised as another line's. */
  ip: string;
}

/**
 * Writes the measurement down.
 *
 * Never throws: the only consequence of a failure is that the next scan does not know what the
 * doctor found, which is exactly how the tool behaved before this file existed. The doctor already
 * reports an unwritable folder in its own "session folder" row, so a second failure line would
 * repeat it.
 */
export async function saveLineSignature(
  dataDir: string,
  input: { preset: string | null; reasons: string[]; ip: string; measuredAt?: number },
): Promise<boolean> {
  const record: StoredSignature = {
    version: SIGNATURE_VERSION,
    measuredAt: input.measuredAt ?? Date.now(),
    preset: input.preset,
    reasons: [...input.reasons],
    ip: input.ip,
  };
  try {
    await mkdir(dataDir, { recursive: true });
    // Written through a temporary file so a scan reading it never sees half a document — the
    // sessions are written the same way.
    const file = join(dataDir, SIGNATURE_FILE);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the measurement back, or `null` when there is none to trust — missing, truncated, written
 * by a future version, or hand-edited into a shape this code does not know. Every one of those is
 * "no measurement", which is a state the scan already handles.
 */
export async function loadLineSignature(dataDir: string): Promise<StoredSignature | null> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, SIGNATURE_FILE), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isStoredSignature(parsed) ? parsed : null;
}

function isStoredSignature(value: unknown): value is StoredSignature {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === SIGNATURE_VERSION &&
    typeof record.measuredAt === 'number' &&
    Number.isFinite(record.measuredAt) &&
    (record.preset === null || typeof record.preset === 'string') &&
    Array.isArray(record.reasons) &&
    record.reasons.every((reason) => typeof reason === 'string') &&
    typeof record.ip === 'string'
  );
}

/** How long ago the measurement ran, in words small enough for a one-line notice. */
export function describeSignatureAge(measuredAt: number, now: number): string {
  const minutes = Math.round(Math.max(0, now - measuredAt) / 60_000);
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** What `adoptPreset` decided. Local: callers read the fields off the return value. */
interface PresetAdoption {
  /** The preset this run should use: the user's own, the measurement's, or none. */
  preset: string | null;
  /** True when `preset` came from the measurement rather than from the command line. */
  adopted: boolean;
  /** One line explaining what was done with the measurement, or null when there is nothing to say. */
  notice: string | null;
  /** The evidence behind an adopted preset; empty otherwise. */
  reasons: string[];
}

const noAdoption = (): PresetAdoption => ({ preset: null, adopted: false, notice: null, reasons: [] });

/**
 * Decides whether the remembered measurement should steer this run.
 *
 * Pure, and the whole rule lives here rather than in the command: an explicit `--preset` always
 * wins and is never second-guessed, `--no-adapt` means the flags are used exactly as typed, and a
 * stale or preset-less measurement applies nothing. Only the two cases where the user benefits
 * from being told — a measurement being applied, and one that has expired — produce a notice; a
 * clean line's verdict would otherwise print on every scan for no reason.
 */
export function adoptPreset(input: {
  /** `--preset` as typed. */
  explicit?: string | undefined;
  stored: StoredSignature | null;
  now: number;
  /** `--no-adapt`. */
  disabled?: boolean;
  ttlMs?: number;
}): PresetAdoption {
  if (input.explicit) return { ...noAdoption(), preset: input.explicit };
  if (input.disabled || !input.stored) return noAdoption();
  const stored = input.stored;
  // A measurement that named no preset is still a measurement — "nothing operator-specific here" —
  // but there is nothing to apply, and repeating that on every scan is noise.
  if (!stored.preset) return noAdoption();
  const ttlMs = input.ttlMs ?? SIGNATURE_TTL_MS;
  // `!(age <= ttl)` rather than `age > ttl` so a clock that ran backwards (a negative age) counts
  // as fresh instead of as expired.
  if (!(input.now - stored.measuredAt <= ttlMs)) {
    return {
      ...noAdoption(),
      notice:
        `the line signature is from ${describeSignatureAge(stored.measuredAt, input.now)} and is too old to ` +
        `apply — the line may have changed since; run \`ezscan doctor\` to re-measure this line ` +
        `(last answer: --preset ${stored.preset})`,
    };
  }
  return {
    preset: stored.preset,
    adopted: true,
    reasons: [...stored.reasons],
    notice:
      `doctor measured this line ${describeSignatureAge(stored.measuredAt, input.now)} and it needs ` +
      `--preset ${stored.preset}`,
  };
}
