import type { DeskChain } from '../../shared/desk';

export interface VerdictRecord {
  order_id: number;
  chain: DeskChain;
  vault: string;
  verdict: 'HOLD' | 'EXIT' | 'MOVE';
  confidence_bps: number;
  risk_bps: number;
  reasons: string[];
  posted_tx: string | null;
  oracle: string | null;
  state_hash: string | null;
  valid_until: number | null;
  explorer_url: string | null;
  grade: null | { adverse: boolean; resolved_at: number | null };
}
export type BuyResult =
  | { orderId: number }
  | { paymentRequired: true; accepts: unknown[] }
  | { refused: string; nextAllowedS?: number }
  | { paymentPending: true; paymentRef: string };
export interface ReinReader {
  ledger(chain?: DeskChain, limit?: number): Promise<unknown>;
  order(id: number): Promise<unknown>;
  policy(): Promise<unknown>;
  menu(chain: DeskChain): Promise<string[]>;
  getOrder(id: number): Promise<unknown | null>;
  nudge(id: number): Promise<void>;
}
export interface Payer {
  buy(chain: DeskChain, vault: string, payment?: string): Promise<BuyResult>;
}
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}
export interface ToolContext {
  progress?(status: string): Promise<void>;
}
export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  handler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}
export type McpToolSet = McpTool[];
