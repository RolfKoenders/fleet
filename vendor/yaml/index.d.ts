// Only the part of yaml that fleet calls: where nodes sit in a file (`range`), never printing one.
export type Range = [start: number, valueEnd: number, nodeEnd: number];

export type ScalarType = "PLAIN" | "QUOTE_DOUBLE" | "QUOTE_SINGLE" | "BLOCK_FOLDED" | "BLOCK_LITERAL";

export class Scalar {
  value: unknown;
  type?: ScalarType;
  range?: Range | null;
  anchor?: string;
  tag?: string;
}

export class Pair {
  key: unknown;
  value: unknown;
}

export class YAMLMap {
  items: Pair[];
  flow?: boolean;
  range?: Range | null;
  anchor?: string;
  tag?: string;
}

export class YAMLSeq {
  items: unknown[];
  flow?: boolean;
  range?: Range | null;
  anchor?: string;
  tag?: string;
}

export class Alias {
  source: string;
}

export class Document {
  contents: unknown;
  errors: { message: string }[];
}

export function parseDocument(source: string): Document;
export function isScalar(node: unknown): node is Scalar;
export function isMap(node: unknown): node is YAMLMap;
export function isSeq(node: unknown): node is YAMLSeq;
export function isAlias(node: unknown): node is Alias;
export function visit(
  node: Document,
  visitor: { Alias?: () => void; Node?: (key: unknown, node: { anchor?: string; tag?: string }) => void },
): void;
