"use client";

// Inventory: per-branch stock on hand computed from an immutable movement
// ledger — deliveries (with unit cost), usage, count corrections, branch
// transfers. Corrections are opposite movements, never edits; the ledger
// is the audit trail. Costing is a weighted average over deliveries.

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, parsePesos } from "@/lib/money";
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, Select,
  SkeletonRows, Table, Td, Th, Truncate, useSort,
} from "@/components/ui";
import { csvPesos, downloadCsv } from "@/lib/csv";
import { Pagination } from "@/components/client-bits";

interface ProductOpt {
  id: string;
  name: string;
  brand: string | null;
  size: string | null;
  unit: string;
  standard_cost_cents: number | null;
  active: boolean;
}

/** "Shampoo 1L — Palmolive, 1 L" — enough to tell look-alikes apart. */
function productLabel(p: ProductOpt): string {
  const detail = [p.brand, p.size].filter(Boolean).join(", ");
  return detail ? `${p.name} — ${detail}` : p.name;
}

interface StockRow {
  product_id: string;
  product_name: string;
  sku: string | null;
  brand: string | null;
  size: string | null;
  unit: string;
  low_stock_threshold: number;
  active: boolean;
  branch_id: string;
  on_hand: number;
  avg_cost_cents: number | null;
  standard_cost_cents: number | null;
  value_cents: number;
  last_moved_on: string | null;
}

interface ActivityRow {
  id: string;
  moved_on: string;
  kind: string;
  qty: number;
  signed_qty: number;
  unit_cost_cents: number | null;
  supplier: string | null;
  note: string | null;
  product_id: string;
  product_name: string;
  sku: string | null;
  brand: string | null;
  size: string | null;
  unit: string;
  branch_id: string;
  branch_name: string;
}

const KIND_LABEL: Record<string, string> = {
  delivery: "Delivery",
  usage: "Usage",
  adjust_in: "Count correction +",
  adjust_out: "Count correction −",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

const ACTIVITY_PAGE = 50;

export default function InventoryPage() {
  const { branchId, branches, businessId, isAdminUp } = useSession();
  const shown = branchId ? branches.filter((b) => b.id === branchId) : branches;
  const shownIds = shown.map((b) => b.id);
  const shownKey = shownIds.join(",");

  const [modal, setModal] = useState<null | "delivery" | "usage" | "adjust" | "transfer">(null);
  // Bumped after any recorded movement so both queries refresh together.
  const [nonce, setNonce] = useState(0);

  const productsQ = useQuery(async () => {
    const res = await createClient()
      .from("products")
      .select("id, name, brand, size, unit, standard_cost_cents, active")
      .eq("business_id", businessId)
      .order("name");
    return unwrap(res) as ProductOpt[];
    // Not keyed on nonce: recording a movement changes stock, never the
    // catalogue — refetching it would only flicker the dropdowns.
  }, [businessId]);

  const stockQ = useQuery(async () => {
    const res = await createClient()
      .from("v_stock_on_hand")
      .select("product_id, product_name, sku, brand, size, unit, low_stock_threshold, active, branch_id, on_hand, avg_cost_cents, standard_cost_cents, value_cents, last_moved_on")
      .in("branch_id", shownIds)
      .order("product_name");
    return unwrap(res) as StockRow[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, nonce]);

  function refresh() {
    setNonce((n) => n + 1);
  }

  const products = productsQ.status === "ready" ? productsQ.data : [];
  const activeProducts = products.filter((p) => p.active);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Inventory</h1>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button onClick={() => setModal("usage")}>Record usage</Button>
          <Button onClick={() => setModal("adjust")}>Count correction</Button>
          {branches.length > 1 && (
            <Button onClick={() => setModal("transfer")}>Transfer</Button>
          )}
          <Button variant="primary" onClick={() => setModal("delivery")}>
            Record delivery
          </Button>
        </div>
      </div>

      <StockCard
        q={stockQ}
        shown={shown}
        hasProducts={productsQ.status !== "ready" || products.length > 0}
      />

      <ActivityCard
        shownIds={shownIds}
        shownKey={shownKey}
        multiBranch={shown.length > 1}
        products={products}
        nonce={nonce}
        canExport={isAdminUp}
      />

      <DeliveryModal
        open={modal === "delivery"}
        products={activeProducts}
        branches={shown}
        onClose={() => setModal(null)}
        onDone={() => { setModal(null); refresh(); }}
      />
      <TakeOutModal
        open={modal === "usage" || modal === "adjust"}
        adjust={modal === "adjust"}
        products={activeProducts}
        branches={shown}
        onClose={() => setModal(null)}
        onDone={() => { setModal(null); refresh(); }}
      />
      <TransferModal
        open={modal === "transfer"}
        products={activeProducts}
        branches={shown}
        onClose={() => setModal(null)}
        onDone={() => { setModal(null); refresh(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stock on hand: one row per product, one on-hand column per branch shown.
// ---------------------------------------------------------------------------

interface StockGroup {
  product_id: string;
  name: string;
  sku: string | null;
  brand: string | null;
  size: string | null;
  unit: string;
  threshold: number;
  active: boolean;
  byBranch: Map<string, number>;
  avg_cost_cents: number | null;
  value_cents: number;
  last: string | null;
}

const STOCK_ACC: Record<string, (g: StockGroup) => unknown> = {
  sku: (g) => g.sku,
  product: (g) => g.name,
  brand: (g) => g.brand,
  size: (g) => g.size,
  unit: (g) => g.unit,
  cost: (g) => g.avg_cost_cents,
  value: (g) => g.value_cents,
  last: (g) => g.last,
};

function StockCard({ q, shown, hasProducts }: {
  q: ReturnType<typeof useQuery<StockRow[]>>;
  shown: { id: string; name: string }[];
  hasProducts: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [search, setSearch] = useState("");

  const groups = (() => {
    if (q.status !== "ready") return null;
    const s = search.trim().toLowerCase();
    const byProduct = new Map<string, StockGroup>();
    for (const r of q.data) {
      if (statusFilter === "active" && !r.active) continue;
      if (s !== "" &&
          ![r.product_name, r.brand, r.sku].some((v) => v?.toLowerCase().includes(s))) {
        continue;
      }
      const g = byProduct.get(r.product_id) ?? {
        product_id: r.product_id, name: r.product_name,
        sku: r.sku, brand: r.brand, size: r.size, unit: r.unit,
        threshold: r.low_stock_threshold, active: r.active,
        byBranch: new Map<string, number>(),
        avg_cost_cents: r.avg_cost_cents ?? r.standard_cost_cents,
        value_cents: 0, last: null,
      };
      g.byBranch.set(r.branch_id, r.on_hand);
      g.value_cents += r.value_cents;
      if (r.last_moved_on && (g.last == null || r.last_moved_on > g.last)) {
        g.last = r.last_moved_on;
      }
      byProduct.set(r.product_id, g);
    }
    return [...byProduct.values()];
  })();

  const { rows, th } = useSort(groups, STOCK_ACC);

  return (
    <Card title="Stock on hand">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="w-56 shrink-0">
          <Input placeholder="Search name, brand or SKU" value={search}
            aria-label="Search stock"
            onChange={(e) => setSearch(e.target.value)} />
        </span>
        <Select value={statusFilter} className="w-36"
          aria-label="Product status filter"
          onChange={(e) => setStatusFilter(e.target.value as "active" | "all")}>
          <option value="active">Active products</option>
          <option value="all">All products</option>
        </Select>
        <p className="ml-auto text-[11px] text-text-muted">
          Counted from the movement ledger — never typed directly. Red = at or
          under the low-stock alert.
        </p>
      </div>
      {q.status === "loading" && <SkeletonRows rows={6} cols={5} />}
      {q.status === "error" && (
        <ErrorState message="Stock levels did not load." onRetry={q.retry} />
      )}
      {q.status === "ready" && !hasProducts && (
        <EmptyState message="No products yet. The owner adds them in Settings → Products." />
      )}
      {rows != null && rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th {...th("sku")}>SKU</Th>
              <Th {...th("product")}>Product</Th>
              <Th {...th("brand")}>Brand</Th>
              <Th {...th("size")}>Size</Th>
              <Th {...th("unit")}>Unit</Th>
              {shown.map((b) => (
                <Th key={b.id} align="right">{shown.length > 1 ? b.name : "On hand"}</Th>
              ))}
              <Th align="right" {...th("cost")}>Unit cost</Th>
              <Th align="right" {...th("value")}>Stock value</Th>
              <Th {...th("last")}>Last movement</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.product_id} className={g.active ? "" : "opacity-50"}>
                <Td className="tnum">{g.sku ?? "—"}</Td>
                <Td className="font-bold">
                  <Truncate text={g.name} max={28} />
                  {!g.active && (
                    <span className="ml-2 text-[11px] text-text-muted">retired</span>
                  )}
                </Td>
                <Td><Truncate text={g.brand ?? "—"} max={16} /></Td>
                <Td>{g.size ?? "—"}</Td>
                <Td>{g.unit}</Td>
                {shown.map((b) => {
                  const oh = g.byBranch.get(b.id) ?? 0;
                  const low = g.threshold > 0 && oh <= g.threshold;
                  return (
                    <Td key={b.id} align="right"
                      className={`tnum${low ? " font-bold text-brand-red" : ""}`}>
                      {oh}
                    </Td>
                  );
                })}
                <Td align="right" className="tnum">
                  {g.avg_cost_cents != null ? formatCentavos(g.avg_cost_cents) : "—"}
                </Td>
                <Td align="right" className="tnum">{formatCentavos(g.value_cents)}</Td>
                <Td className="tnum">{g.last ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Activity: the ledger, filterable by product (per-item audit) and kind.
// ---------------------------------------------------------------------------

function ActivityCard({ shownIds, shownKey, multiBranch, products, nonce, canExport }: {
  shownIds: string[];
  shownKey: string;
  multiBranch: boolean;
  products: ProductOpt[];
  nonce: number;
  canExport: boolean;
}) {
  const [productFilter, setProductFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [shownKey, productFilter, kindFilter]);

  const q = useQuery(async () => {
    let query = createClient()
      .from("v_stock_activity")
      .select("id, moved_on, kind, qty, signed_qty, unit_cost_cents, supplier, note, product_id, product_name, unit, branch_id, branch_name", { count: "exact" })
      .in("branch_id", shownIds)
      .order("moved_on", { ascending: false })
      .order("created_at", { ascending: false })
      .range(page * ACTIVITY_PAGE, page * ACTIVITY_PAGE + ACTIVITY_PAGE - 1);
    if (productFilter) query = query.eq("product_id", productFilter);
    if (kindFilter) query = query.eq("kind", kindFilter);
    const res = await query;
    return { rows: unwrap(res) as ActivityRow[], total: res.count ?? 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, productFilter, kindFilter, page, nonce]);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);

  async function exportCsv() {
    setExporting(true);
    setExportError(false);
    try {
      const supabase = createClient();
      const PAGE = 1000;
      const all: ActivityRow[] = [];
      for (let offset = 0; ; offset += PAGE) {
        let query = supabase
          .from("v_stock_activity")
          .select("id, moved_on, kind, qty, signed_qty, unit_cost_cents, supplier, note, product_id, product_name, sku, brand, size, unit, branch_id, branch_name")
          .in("branch_id", shownIds)
          .order("moved_on", { ascending: true })
          .order("created_at", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (productFilter) query = query.eq("product_id", productFilter);
        if (kindFilter) query = query.eq("kind", kindFilter);
        const chunk = unwrap(await query) as ActivityRow[];
        all.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      downloadCsv(
        `inventory-activity.csv`,
        ["Date", "SKU", "Product", "Brand", "Size", "Unit", "Branch",
         "Movement", "Qty", "Unit cost", "Supplier", "Note"],
        all.map((r) => [
          r.moved_on, r.sku, r.product_name, r.brand, r.size, r.unit,
          r.branch_name, KIND_LABEL[r.kind] ?? r.kind, r.signed_qty,
          r.unit_cost_cents != null ? csvPesos(r.unit_cost_cents) : "",
          r.supplier, r.note,
        ]),
      );
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card title="Activity">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={productFilter} className="w-64" aria-label="Filter by product"
          onChange={(e) => setProductFilter(e.target.value)}>
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.active ? "" : " (retired)"}</option>
          ))}
        </Select>
        <Select value={kindFilter} className="w-48" aria-label="Filter by movement"
          onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">All movements</option>
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </Select>
        <span className="ml-auto flex items-center gap-2">
          {exportError && (
            <span className="text-[11px] text-brand-red">Export failed — try again.</span>
          )}
          {canExport && (
            <Button busy={exporting} busyLabel="Exporting"
              disabled={q.status !== "ready" || q.data.total === 0}
              onClick={() => void exportCsv()}>
              Export CSV
            </Button>
          )}
        </span>
      </div>

      {q.status === "loading" && <SkeletonRows rows={6} cols={6} />}
      {q.status === "error" && (
        <ErrorState message="The activity ledger did not load." onRetry={q.retry} />
      )}
      {q.status === "ready" && q.data.rows.length === 0 && (
        <EmptyState message={productFilter || kindFilter
          ? "No movements match these filters."
          : "No stock movements yet. Record the first delivery to begin."} />
      )}
      {q.status === "ready" && q.data.rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Product</Th>
              {multiBranch && <Th>Branch</Th>}
              <Th>Movement</Th>
              <Th align="right">Qty</Th>
              <Th align="right">Unit cost</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {q.data.rows.map((r) => (
              <tr key={r.id}>
                <Td className="tnum">{r.moved_on}</Td>
                <Td>
                  <Truncate
                    text={[r.product_name, [r.brand, r.size].filter(Boolean).join(", ")]
                      .filter(Boolean).join(" — ")}
                    max={36}
                  />
                </Td>
                {multiBranch && <Td>{r.branch_name}</Td>}
                <Td>{KIND_LABEL[r.kind] ?? r.kind}</Td>
                <Td align="right"
                  className={`tnum${r.signed_qty < 0 ? "" : " font-bold"}`}>
                  {r.signed_qty > 0 ? `+${r.signed_qty}` : r.signed_qty}
                </Td>
                <Td align="right" className="tnum">
                  {r.unit_cost_cents != null ? formatCentavos(r.unit_cost_cents) : "—"}
                </Td>
                <Td>
                  <Truncate text={[r.supplier, r.note].filter(Boolean).join(" — ") || "—"} max={40} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {q.status === "ready" && (
        <Pagination page={page} total={q.data.total} onPage={setPage}
          noun="movements" pageSize={ACTIVITY_PAGE} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Movement dialogs
// ---------------------------------------------------------------------------

function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

function useMoveForm(open: boolean, branches: { id: string }[]) {
  const [productId, setProductId] = useState("");
  const [branchIdSel, setBranchIdSel] = useState(branches[0]?.id ?? "");
  const [qtyInput, setQtyInput] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setProductId("");
    setBranchIdSel(branches[0]?.id ?? "");
    setQtyInput("");
    setDate(todayISO());
    setNote("");
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return {
    productId, setProductId, branchIdSel, setBranchIdSel, qtyInput, setQtyInput,
    date, setDate, note, setNote, error, setError, busy, setBusy,
  };
}

function ProductBranchFields({ f, products, branches }: {
  f: ReturnType<typeof useMoveForm>;
  products: ProductOpt[];
  branches: { id: string; name: string }[];
}) {
  return (
    <>
      <Field label="Product">
        <Select value={f.productId} onChange={(e) => f.setProductId(e.target.value)}>
          <option value="">Pick a product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{productLabel(p)} ({p.unit})</option>
          ))}
        </Select>
      </Field>
      {branches.length > 1 && (
        <Field label="Branch">
          <Select value={f.branchIdSel} onChange={(e) => f.setBranchIdSel(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}

function moveErrorMessage(message: string): string {
  if (/on hand/i.test(message)) return message;
  if (/closed/i.test(message)) {
    return "The cash day is closed, so the linked expense cannot be added. Reopen the day, or record the delivery without the cash expense.";
  }
  return "The movement was not saved. Check the fields and try again.";
}

function DeliveryModal({ open, products, branches, onClose, onDone }: {
  open: boolean;
  products: ProductOpt[];
  branches: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const profileId = useSession().profile.id;
  const f = useMoveForm(open, branches);
  const [costInput, setCostInput] = useState("");
  const [supplier, setSupplier] = useState("");
  const [asExpense, setAsExpense] = useState(false);
  const [paidFrom, setPaidFrom] = useState<"cash" | "bank">("cash");

  useEffect(() => {
    if (!open) return;
    setCostInput("");
    setSupplier("");
    setAsExpense(false);
    setPaidFrom("cash");
  }, [open]);

  // The catalogue's standard cost pre-fills the field; a typed-over value
  // is kept, and switching products replaces only an untouched pre-fill.
  const prefillRef = useRef("");
  useEffect(() => {
    const p = products.find((x) => x.id === f.productId);
    const std = p?.standard_cost_cents != null ? String(p.standard_cost_cents / 100) : "";
    setCostInput((cur) => (cur === "" || cur === prefillRef.current ? std : cur));
    prefillRef.current = std;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.productId]);

  const qty = Number(f.qtyInput);
  const unitCost = parsePesos(costInput);
  const totalCents = unitCost != null && Number.isInteger(qty) && qty > 0
    ? unitCost * qty : null;

  async function submit() {
    if (!f.productId) { f.setError("Pick a product."); return; }
    if (!Number.isInteger(qty) || qty <= 0) { f.setError("Quantity must be a whole number of at least 1."); return; }
    if (costInput !== "" && (unitCost == null || unitCost < 0)) {
      f.setError("Unit cost must be a peso amount, or left blank.");
      return;
    }
    if (asExpense && totalCents == null) {
      f.setError("A linked expense needs the unit cost filled in.");
      return;
    }
    f.setBusy(true);
    f.setError(null);
    const supabase = createClient();
    const product = products.find((p) => p.id === f.productId);

    let expenseId: string | null = null;
    if (asExpense && totalCents != null) {
      const { data, error } = await supabase
        .from("expenses")
        .insert({
          branch_id: f.branchIdSel,
          spent_on: f.date,
          category: "supplies",
          amount_cents: totalCents,
          description: `${qty} ${product?.unit ?? ""} ${product?.name ?? "product"}${supplier.trim() ? ` — ${supplier.trim()}` : ""}`,
          paid_from: paidFrom,
          recorded_by: profileId,
        })
        .select("id")
        .single();
      if (error) {
        f.setBusy(false);
        f.setError(moveErrorMessage(error.message));
        return;
      }
      expenseId = (data as { id: string }).id;
    }

    const { error } = await supabase.from("stock_moves").insert({
      product_id: f.productId,
      branch_id: f.branchIdSel,
      moved_on: f.date,
      kind: "delivery",
      qty,
      unit_cost_cents: unitCost,
      supplier: supplier.trim() || null,
      note: f.note.trim() || null,
      expense_id: expenseId,
      recorded_by: profileId,
    });
    f.setBusy(false);
    if (error) {
      f.setError(moveErrorMessage(error.message));
      return;
    }
    onDone();
  }

  return (
    <Modal title="Record delivery" open={open} onClose={onClose}>
      <div className="space-y-4">
        <ProductBranchFields f={f} products={products} branches={branches} />
        {/* Wrap, never squeeze: squeezed date inputs overflow their border. */}
        <div className="flex flex-wrap gap-4">
          <Field label="Quantity">
            <Input inputMode="numeric" value={f.qtyInput} className="w-24"
              onChange={(e) => f.setQtyInput(e.target.value)} />
          </Field>
          <Field label="Unit cost (₱)" hint="Blank if unknown">
            <Input inputMode="decimal" value={costInput} className="w-28"
              onChange={(e) => setCostInput(e.target.value)} />
          </Field>
          <Field label="Date">
            <Input type="date" value={f.date} max={todayISO()} className="w-40"
              onChange={(e) => f.setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Supplier">
          <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <Field label="Note">
          <Input value={f.note} onChange={(e) => f.setNote(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={asExpense} className="mt-0.5"
            onChange={(e) => setAsExpense(e.target.checked)} />
          <span>
            Also record as an expense in Daily cash
            {totalCents != null && <> ({formatCentavos(totalCents)})</>}
            <span className="block text-[11px] text-text-muted">
              Tick only if this delivery was paid for by the branch — it will
              appear under Cash expenses &amp; deductions.
            </span>
          </span>
        </label>
        {asExpense && (
          <Field label="Paid from">
            <Select value={paidFrom} className="w-28"
              onChange={(e) => setPaidFrom(e.target.value as "cash" | "bank")}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </Select>
          </Field>
        )}
        {f.error && <p className="text-[11px] text-brand-red">{f.error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={f.busy} busyLabel="Saving" onClick={() => void submit()}>
            Record delivery
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TakeOutModal({ open, adjust, products, branches, onClose, onDone }: {
  open: boolean;
  adjust: boolean;
  products: ProductOpt[];
  branches: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const profileId = useSession().profile.id;
  const f = useMoveForm(open, branches);
  const [direction, setDirection] = useState<"adjust_out" | "adjust_in">("adjust_out");
  useEffect(() => { if (open) setDirection("adjust_out"); }, [open]);

  const qty = Number(f.qtyInput);

  async function submit() {
    if (!f.productId) { f.setError("Pick a product."); return; }
    if (!Number.isInteger(qty) || qty <= 0) { f.setError("Quantity must be a whole number of at least 1."); return; }
    if (adjust && f.note.trim() === "") {
      f.setError("A count correction needs a reason — say what was found.");
      return;
    }
    f.setBusy(true);
    f.setError(null);
    const { error } = await createClient().from("stock_moves").insert({
      product_id: f.productId,
      branch_id: f.branchIdSel,
      moved_on: f.date,
      kind: adjust ? direction : "usage",
      qty,
      note: f.note.trim() || null,
      recorded_by: profileId,
    });
    f.setBusy(false);
    if (error) {
      f.setError(moveErrorMessage(error.message));
      return;
    }
    onDone();
  }

  return (
    <Modal title={adjust ? "Count correction" : "Record usage"} open={open} onClose={onClose}>
      <div className="space-y-4">
        {adjust && (
          <p className="text-[13px] text-text-muted">
            After a physical count, correct the book figure here. The original
            movements stay on record — this adds a correcting entry.
          </p>
        )}
        <ProductBranchFields f={f} products={products} branches={branches} />
        <div className="flex flex-wrap gap-4">
          {adjust && (
            <Field label="Direction">
              <Select value={direction} className="w-40"
                onChange={(e) => setDirection(e.target.value as "adjust_out" | "adjust_in")}>
                <option value="adjust_out">Remove from stock</option>
                <option value="adjust_in">Add to stock</option>
              </Select>
            </Field>
          )}
          <Field label="Quantity">
            <Input inputMode="numeric" value={f.qtyInput} className="w-24"
              onChange={(e) => f.setQtyInput(e.target.value)} />
          </Field>
          <Field label="Date">
            <Input type="date" value={f.date} max={todayISO()} className="w-40"
              onChange={(e) => f.setDate(e.target.value)} />
          </Field>
        </div>
        <Field label={adjust ? "Reason (required)" : "Note"}>
          <Input value={f.note} onChange={(e) => f.setNote(e.target.value)} />
        </Field>
        {f.error && <p className="text-[11px] text-brand-red">{f.error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={f.busy} busyLabel="Saving" onClick={() => void submit()}>
            {adjust ? "Save correction" : "Record usage"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TransferModal({ open, products, branches, onClose, onDone }: {
  open: boolean;
  products: ProductOpt[];
  branches: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const f = useMoveForm(open, branches);
  const [destinations, setDestinations] = useState<{ id: string; name: string }[]>([]);
  const [destId, setDestId] = useState("");

  useEffect(() => {
    if (!open || !f.branchIdSel) return;
    let alive = true;
    void (async () => {
      const { data } = await createClient()
        .rpc("f_stock_destinations", { p_from: f.branchIdSel });
      if (!alive) return;
      const list = (data ?? []) as { id: string; name: string }[];
      setDestinations(list);
      setDestId(list[0]?.id ?? "");
    })();
    return () => { alive = false; };
  }, [open, f.branchIdSel]);

  const qty = Number(f.qtyInput);

  async function submit() {
    if (!f.productId) { f.setError("Pick a product."); return; }
    if (!destId) { f.setError("Pick the receiving branch."); return; }
    if (!Number.isInteger(qty) || qty <= 0) { f.setError("Quantity must be a whole number of at least 1."); return; }
    f.setBusy(true);
    f.setError(null);
    const { error } = await createClient().rpc("transfer_stock", {
      p_product: f.productId,
      p_from: f.branchIdSel,
      p_to: destId,
      p_qty: qty,
      p_note: f.note.trim() || null,
    });
    f.setBusy(false);
    if (error) {
      f.setError(moveErrorMessage(error.message));
      return;
    }
    onDone();
  }

  return (
    <Modal title="Transfer between branches" open={open} onClose={onClose}>
      <div className="space-y-4">
        <ProductBranchFields f={f} products={products} branches={branches} />
        <Field label="To branch">
          <Select value={destId} onChange={(e) => setDestId(e.target.value)}>
            {destinations.length === 0 && <option value="">No other branch</option>}
            {destinations.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-4">
          <Field label="Quantity">
            <Input inputMode="numeric" value={f.qtyInput} className="w-24"
              onChange={(e) => f.setQtyInput(e.target.value)} />
          </Field>
        </div>
        <Field label="Note">
          <Input value={f.note} onChange={(e) => f.setNote(e.target.value)} />
        </Field>
        {f.error && <p className="text-[11px] text-brand-red">{f.error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={f.busy} busyLabel="Transferring" onClick={() => void submit()}>
            Transfer
          </Button>
        </div>
      </div>
    </Modal>
  );
}
