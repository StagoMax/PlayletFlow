export type DiffLine = {
  kind: "unchanged" | "removed" | "added";
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};

const MAX_MATRIX_CELLS = 60_000;

export function buildLineDiff(beforeValue: string, proposedValue: string): DiffLine[] {
  const before = toLines(beforeValue);
  const after = toLines(proposedValue);
  if (before.length * after.length > MAX_MATRIX_CELLS) return coarseDiff(before, after);

  const common = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      common[beforeIndex][afterIndex] = before[beforeIndex] === after[afterIndex]
        ? common[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(common[beforeIndex + 1][afterIndex], common[beforeIndex][afterIndex + 1]);
    }
  }

  const result: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      result.push(line("unchanged", before[beforeIndex], beforeIndex, afterIndex));
      beforeIndex += 1;
      afterIndex += 1;
    } else if (common[beforeIndex + 1][afterIndex] >= common[beforeIndex][afterIndex + 1]) {
      result.push(line("removed", before[beforeIndex], beforeIndex, null));
      beforeIndex += 1;
    } else {
      result.push(line("added", after[afterIndex], null, afterIndex));
      afterIndex += 1;
    }
  }
  while (beforeIndex < before.length) {
    result.push(line("removed", before[beforeIndex], beforeIndex, null));
    beforeIndex += 1;
  }
  while (afterIndex < after.length) {
    result.push(line("added", after[afterIndex], null, afterIndex));
    afterIndex += 1;
  }
  return result;
}

function coarseDiff(before: string[], after: string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  return [
    ...before.slice(0, prefix).map((text, index) => line("unchanged", text, index, index)),
    ...before.slice(prefix, before.length - suffix).map((text, index) => line("removed", text, prefix + index, null)),
    ...after.slice(prefix, after.length - suffix).map((text, index) => line("added", text, null, prefix + index)),
    ...before.slice(before.length - suffix).map((text, index) => {
      const beforeIndex = before.length - suffix + index;
      const afterIndex = after.length - suffix + index;
      return line("unchanged", text, beforeIndex, afterIndex);
    }),
  ];
}

function line(
  kind: DiffLine["kind"],
  text: string,
  beforeIndex: number | null,
  afterIndex: number | null,
): DiffLine {
  return {
    kind,
    text,
    beforeLine: beforeIndex === null ? null : beforeIndex + 1,
    afterLine: afterIndex === null ? null : afterIndex + 1,
  };
}

function toLines(value: string) {
  return value === "" ? [] : value.replace(/\r\n/g, "\n").split("\n");
}
