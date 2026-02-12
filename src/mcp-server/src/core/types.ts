export type PagingType =
  | "NEXT_URI"
  | "NEXT_PAGE"
  | "CURSOR"
  | "AFTER"
  | "PAGE_NUMBER"
  | "TOTALHITS"
  | "START_INDEX"
  | "UNKNOWN";

export type JsonObject = Record<string, unknown>;

export type HttpishError = Error & {
  statusCode?: number;
  details?: unknown;
};

export type OperationParameter = {
  name: string;
  in: string;
  required: boolean;
  type?: string | null;
  schema?: any;
};

export type Operation = {
  catalogKey?: string;
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  summary?: string;
  description?: string;
  security?: any[];
  requiredPermissions?: string[] | null;
  parameters: OperationParameter[];
  pagingType: PagingType;
  responseItemsPath?: string | null;
};

export type ClientConfig = {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
};

export type PagingMapEntry = {
  type: PagingType;
  itemsPath?: string | null;
};

export type PolicyList = {
  operationIds: Set<string>;
  tags: Set<string>;
  hasEntries: boolean;
};

export type LoggingPolicyRule = {
  params: string[];
  bodyPaths: string[];
};

export type LoggingPolicy = {
  defaultRule: LoggingPolicyRule;
  operationRules: Map<string, LoggingPolicyRule>;
};

export type DescribeInput = {
  operationId: string;
};

export type SearchOperationsInput = {
  query: string;
  method?: string;
  tag?: string;
  limit?: number;
};

export type CallInput = {
  operationId: string;
  params?: JsonObject;
  body?: unknown;
  client?: unknown;
};

export type CallAllInput = {
  operationId: string;
  params?: JsonObject;
  body?: unknown;
  client?: unknown;
  pageSize?: number;
  limit?: number;
  maxPages?: number;
  maxRuntimeMs?: number;
  includeItems?: boolean;
};

export type DescribeOutput = {
  operation: Operation;
  paging: PagingMapEntry;
  policy: JsonObject;
};

export type SearchOperationsOutput = {
  count: number;
  operations: Operation[];
};

export type CallOutput = {
  data: unknown;
  warnings?: string[];
};

export type CallAllOutput = {
  operationId: string;
  pagingType: PagingType;
  itemsPath: string;
  limit: number;
  maxPages: number;
  pageSize: number;
  maxRuntimeMs: number;
  totalFetched: number;
  returnedItems: number;
  items: unknown[];
  audit: JsonObject[];
  warnings?: string[];
};

export type CoreConfig = {
  repoRoot: string;
  serverApiKey: string;
  allowWriteOperations: boolean;
  allowClientOverrides: boolean;
  allowInsecureHttp: boolean;
  allowArrayFallback: boolean;
  defaultIncludeItems: boolean;
  requestBodyLimit: string;
  hardMaxLimit: number;
  hardMaxPages: number;
  hardMaxRuntimeMs: number;
  defaultPageSize: number;
  defaultLimit: number;
  defaultMaxPages: number;
  defaultMaxRuntimeMs: number;
  httpTimeoutMs: number;
  maxRetries: number;
  allowedBaseHosts: Set<string>;
  allowedTokenHosts: Set<string>;
  strictBodySchema: boolean;
  logRequestPayloads: boolean;
  mcpPath: string;
  healthPath: string;
  legacyHttpApi: boolean;
  host: string;
  port: number;
};

export type CoreServiceOptions = {
  config?: Partial<CoreConfig>;
  operations?: Record<string, Operation>;
  pagingMap?: Record<string, PagingMapEntry>;
  definitions?: Record<string, unknown>;
};

