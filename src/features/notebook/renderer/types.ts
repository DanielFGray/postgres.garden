export type SqlValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Uint8Array
  | readonly SqlValue[]
  | { readonly [key: string]: SqlValue };

export interface SQLResult {
  fields: Array<{ name: string; dataTypeID?: number }>;
  rows: Array<Record<string, SqlValue>>;
  query?: string;
}

export interface RendererProps {
  data: SQLResult;
  mime: string;
}
