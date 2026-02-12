export interface SQLResult {
  fields: Array<{ name: string; dataTypeID?: number }>;
  rows: Array<Record<string, unknown>>;
  query?: string;
}

export interface RendererProps {
  data: SQLResult;
  mime: string;
}
