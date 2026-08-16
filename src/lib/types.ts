// Domain types mirroring the database (supabase/migrations).

export type Role = "owner" | "admin" | "manager" | "front_desk";

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  branch_id: string | null; // null = all branches (owner only)
  active: boolean;
}

export interface Business {
  id: string;
  name: string;
  code: string;
  sort_order: number;
  active: boolean;
  /** Identity accent only — never an action or status colour. */
  brand_color: string;
  wordmark: string | null;
  wordmark_accent: string | null;
  tagline: string | null;
  logo_path: string | null;
}

export interface Branch {
  id: string;
  business_id: string;
  name: string;
  code: string;
  accent: "slate" | "plum";
  monthly_target_cents: number;
  active: boolean;
}

export interface ServiceType {
  id: string;
  business_id: string;
  name: string;
  sort_order: number;
}

export interface Service {
  id: string;
  service_type_id: string;
  name: string;
  default_sharing_rate: number;
  default_duration_min: number;
  active: boolean;
}

export interface BranchServicePrice {
  id: string;
  branch_id: string;
  service_id: string;
  price_cents: number;
  sharing_rate: number | null;
  effective_from: string;
}

export interface Technician {
  id: string;
  branch_id: string;
  full_name: string;
  active: boolean;
  hired_on: string | null;
  specialty: string | null;
  skill_level: "trainee" | "junior" | "senior" | "master" | null;
}

export interface Client {
  id: string;
  client_no: number;
  phone: string;
  phone_declined: boolean;
  full_name: string | null;
  barangay: string | null;
  town: string | null;
  inquiry_source: string | null;
  referred_by_client_id: string | null;
  first_visit_on: string | null;
  birth_month: number | null;
  birth_day: number | null;
  /** Standing discount applied to every service, as "special" on lines. */
  special_discount_pct: number | null;
  notes: string | null;
  merged_into_id: string | null;
}

export type PaymentMethod =
  "cash" | "gcash" | "maya" | "bank" | "card" | "package" | "comp" | "gift_cert";

export interface Ticket {
  id: string;
  branch_id: string;
  /** open = parked at the counter, not yet billed; counted nowhere. */
  status: "open" | "closed";
  series_no: string | null;
  client_id: string;
  ticket_date: string;
  started_at: string | null;
  ended_at: string | null;
  payment_method: "cash" | "online" | "split" | "package" | "comp" | "gift_cert";
  online_ref: string | null;
  is_new_client: boolean;
  idempotency_key: string;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

export type DiscountType =
  "senior" | "pwd" | "staff" | "promo" | "negotiated" | "package" | "birthday" | "special";

export interface TicketLine {
  id: string;
  ticket_id: string;
  service_id: string;
  technician_id: string;
  assist_technician_id: string | null;
  is_upsell: boolean;
  started_at: string | null;
  ended_at: string | null;
  qty: number;
  unit_price_cents: number;
  discount_type: DiscountType | null;
  discount_cents: number;
  sharing_rate: number;
  rating: number | null;
  line_number: number;
  total_cents: number;
  company_share_cents: number;
  technician_share_cents: number;
}

export interface Package {
  id: string;
  client_id: string;
  service_id: string;
  branch_id: string | null;
  sessions_total: number;
  sessions_used: number;
  purchased_on: string;
  expires_on: string | null;
  amount_paid_cents: number;
}

export interface Expense {
  id: string;
  branch_id: string;
  spent_on: string;
  category: string;
  amount_cents: number;
  description: string | null;
  paid_from: "cash" | "bank";
}

export interface CashDay {
  id: string;
  branch_id: string;
  business_date: string;
  opening_float_cents: number;
  counted_cash_cents: number | null;
  closed_at: string | null;
  note: string | null;
}

// Payload for the create_ticket RPC (supabase/migrations/0003_rpc.sql).
export interface TicketPayload {
  idempotency_key: string;
  branch_id: string;
  ticket_date?: string;
  client: {
    id?: string;
    phone?: string;
    phone_declined?: boolean;
    full_name?: string;
    barangay?: string;
    town?: string;
    inquiry_source?: string;
    referred_by_client_id?: string;
    birth_month?: number;
    birth_day?: number;
  };
  started_at?: string;
  ended_at?: string;
  online_ref?: string;
  /** Overrides the history-derived flag when the front desk knows better. */
  is_new_client?: boolean;
  lines: Array<{
    service_id: string;
    technician_id: string;
    assist_technician_id?: string;
    qty: number;
    unit_price_cents: number;
    discount_type?: DiscountType;
    discount_cents?: number;
    sharing_rate: number;
    rating?: number;
    package_id?: string;
    is_upsell?: boolean;
    started_at?: string;
    ended_at?: string;
  }>;
  payments: Array<{
    method: PaymentMethod;
    amount_cents: number;
    reference?: string;
  }>;
}
