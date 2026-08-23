"use client";

// Owner settings (spec §3): price lists, sharing rates, monthly targets,
// technicians, staff accounts. RLS enforces owner-only writes; the UI just
// reflects it. Price changes insert a new effective_from row — history is
// never rewritten (edge case 17).

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, UserCheck, UserX } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, parsePesos } from "@/lib/money";
import type { Branch, Service, ServiceType, Technician } from "@/lib/types";
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, Select,
  SkeletonRows, Table, Td, Th, Truncate, useSort,
} from "@/components/ui";

interface PriceRow { branch_id: string; service_id: string; price_cents: number; effective_from: string }
interface ProfileRow { id: string; full_name: string; role: string; branch_id: string | null; active: boolean }

export default function SettingsPage() {
  const { isOwner } = useSession();
  if (!isOwner) {
    return <EmptyState message="Settings are the owner's. Prices, targets and accounts live here." />;
  }
  return <SettingsBody />;
}

function SettingsBody() {
  const { branches } = useSession();
  const [tab, setTab] = useState<"services" | "products" | "costing" | "technicians" | "targets" | "users" | "businesses">("services");

  return (
    <div className="space-y-6">
      <h1 className="text-[20px] font-bold">Settings</h1>

      <div className="flex rounded-[4px] border border-border w-fit">
        {([
          ["services", "Services and prices"],
          ["products", "Products"],
          ["costing", "Costing"],
          ["technicians", "Technicians"],
          ["targets", "Targets"],
          ["users", "Staff accounts"],
          ["businesses", "Businesses"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`h-8 px-4 text-[13px] ${
              tab === key ? "bg-ink font-bold text-white" : "hover:bg-surface-page"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "services" && <ServicesTab branches={branches} />}
      {tab === "products" && <ProductsTab />}
      {tab === "costing" && <CostingTab branches={branches} />}
      {tab === "technicians" && <TechniciansTab branches={branches} />}
      {tab === "targets" && <TargetsTab branches={branches} />}
      {tab === "users" && <UsersTab branches={branches} />}
      {tab === "businesses" && <BusinessesTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Services and prices
// ---------------------------------------------------------------------------

interface SvcRow { s: Service; typeName: string }

const SERVICE_ACC: Record<string, (r: SvcRow) => unknown> = {
  service: (r) => r.s.name,
  type: (r) => r.typeName,
  share: (r) => Number(r.s.default_sharing_rate),
  duration: (r) => r.s.default_duration_min,
  status: (r) => (r.s.active ? "Active" : "Retired"),
};

function ServicesTab({ branches }: { branches: Branch[] }) {
  const { businessId, branchId } = useSession();
  const [editing, setEditing] = useState<{ service: Service; branch: Branch; current: number | null } | null>(null);
  const [serviceEditing, setServiceEditing] = useState<Service | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "retired">("active");

  // The header's branch switcher decides which price columns show.
  const shownBranches = branchId ? branches.filter((b) => b.id === branchId) : branches;

  const q = useQuery(async () => {
    const supabase = createClient();
    const today = new Date().toLocaleDateString("sv-SE");
    const [typesRes, servicesRes] = await Promise.all([
      supabase.from("service_types").select("*").order("sort_order"),
      supabase.from("services").select("*").order("name"),
    ]);
    // Price history only grows (every change inserts a row) and the current
    // price may be an OLD row for a stable service — page past the 1,000-row
    // response cap or long-priced services would wrongly show "not offered".
    const PAGE = 1000;
    const priceRows: PriceRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await supabase
        .from("branch_service_prices")
        .select("branch_id, service_id, price_cents, effective_from")
        .lte("effective_from", today)
        .order("effective_from", { ascending: false })
        .order("branch_id", { ascending: true })
        .order("service_id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      const chunk = unwrap(res) as PriceRow[];
      priceRows.push(...chunk);
      if (chunk.length < PAGE) break;
    }
    const priceMap = new Map<string, PriceRow>();
    for (const p of priceRows) {
      const key = `${p.branch_id}:${p.service_id}`;
      if (!priceMap.has(key)) priceMap.set(key, p);
    }
    // Only the selected business's catalogue is editable here.
    const types = (unwrap(typesRes) as ServiceType[]).filter(
      (t) => t.business_id === businessId,
    );
    const typeIds = new Set(types.map((t) => t.id));
    return {
      types,
      services: (unwrap(servicesRes) as Service[]).filter((s) => typeIds.has(s.service_type_id)),
      priceMap,
    };
  }, [businessId]);

  const data = q.status === "ready" ? q.data : null;

  const filtered = useMemo(() => {
    if (!data) return null;
    const typeName = new Map(data.types.map((t) => [t.id, t.name]));
    return data.services
      .filter((s) => (typeFilter === "" || s.service_type_id === typeFilter))
      .filter((s) =>
        statusFilter === "" ? true : statusFilter === "active" ? s.active : !s.active)
      .map((s): SvcRow => ({ s, typeName: typeName.get(s.service_type_id) ?? "—" }));
  }, [data, typeFilter, statusFilter]);

  const accessors = useMemo(() => {
    const m: Record<string, (r: SvcRow) => unknown> = { ...SERVICE_ACC };
    for (const b of branches) {
      m[`price:${b.id}`] = (r) =>
        data?.priceMap.get(`${b.id}:${r.s.id}`)?.price_cents ?? null;
    }
    return m;
  }, [branches, data]);

  const { rows, th } = useSort(filtered, accessors);

  if (q.status === "loading") return <Card><SkeletonRows rows={10} cols={5} /></Card>;
  if (q.status === "error") {
    return <ErrorState message="Services did not load." onRetry={q.retry} />;
  }

  return (
    <Card title="Services and prices">
      <p className="mb-4 text-[11px] text-text-muted">
        Click a service name to edit it; click a price to change that branch&apos;s price. A price
        change adds a new row effective today — past tickets keep the price they were sold at.
        The sharing rate shown is the company&apos;s side.
      </p>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="flex items-end gap-2">
          <AddServiceButton types={data?.types ?? []} onChanged={q.retry} />
          <AddServiceTypeButton businessId={businessId} onChanged={q.retry} />
        </div>
        <div className="flex items-end gap-2">
          <Field label="Type">
            <Select value={typeFilter} className="w-36"
              onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {(data?.types ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={statusFilter} className="w-32"
              onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "retired")}>
              <option value="active">Active</option>
              <option value="retired">Retired</option>
              <option value="">All</option>
            </Select>
          </Field>
        </div>
      </div>

      {rows != null && rows.length === 0 && (
        <EmptyState message="No services match these filters." />
      )}
      {rows != null && rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th {...th("service")}>Service</Th>
              <Th {...th("type")}>Type</Th>
              <Th align="right" {...th("share")}>Company share</Th>
              <Th align="right" {...th("duration")}>Duration</Th>
              {shownBranches.map((b) => (
                <Th key={b.id} align="right" {...th(`price:${b.id}`)}>{b.name} price</Th>
              ))}
              <Th {...th("status")}>Status</Th>
              <Th align="right">Status toggle</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, typeName }) => (
              <tr key={s.id} className={s.active ? "" : "opacity-50"}>
                <Td>
                  <button className="font-bold hover:underline" onClick={() => setServiceEditing(s)}>
                    <Truncate text={s.name} />
                  </button>
                </Td>
                <Td className="text-text-muted">{typeName}</Td>
                <Td align="right" className="tnum">
                  <button className="hover:underline" onClick={() => setServiceEditing(s)}>
                    {(Number(s.default_sharing_rate) * 100).toFixed(0)}%
                  </button>
                </Td>
                <Td align="right" className="tnum">{s.default_duration_min} min</Td>
                {shownBranches.map((b) => {
                  const p = data?.priceMap.get(`${b.id}:${s.id}`);
                  return (
                    <Td key={b.id} align="right" className="tnum">
                      <button
                        className="hover:underline"
                        onClick={() =>
                          setEditing({ service: s, branch: b, current: p?.price_cents ?? null })
                        }
                      >
                        {p ? formatCentavos(p.price_cents) : (
                          <span className="text-text-muted">not offered</span>
                        )}
                      </button>
                    </Td>
                  );
                })}
                <Td>{s.active ? "Active" : <span className="text-text-muted">Retired</span>}</Td>
                <Td align="right">
                  <ToggleActive
                    table="services" id={s.id} name={s.name} active={s.active} onChanged={q.retry}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <PriceModal
        editing={editing}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); q.retry(); }}
      />
      <EditServiceModal
        service={serviceEditing}
        types={data?.types ?? []}
        onClose={() => setServiceEditing(null)}
        onDone={() => { setServiceEditing(null); q.retry(); }}
      />
    </Card>
  );
}

function AddServiceButton({ types, onChanged }: { types: ServiceType[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [ratePct, setRatePct] = useState("60");
  const [duration, setDuration] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const rate = Number(ratePct);
    const mins = Number(duration);
    if (name.trim() === "") { setError("The service needs a name."); return; }
    if (!typeId) { setError("Pick a service type."); return; }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      setError("Company share must be 0 to 100."); return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().from("services").insert({
      name: name.trim(),
      service_type_id: typeId,
      default_sharing_rate: (rate / 100).toFixed(3),
      default_duration_min: Number.isFinite(mins) && mins > 0 ? mins : 60,
    });
    setBusy(false);
    if (error) {
      setError(/unique/i.test(error.message)
        ? "That service already exists under this type."
        : "The service was not added. Try again.");
      return;
    }
    setName("");
    setOpen(false);
    onChanged();
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>Add service</Button>
      <Modal title="Add service" open={open} onClose={() => setOpen(false)}>
        <p className="mb-4 text-[13px] text-text-muted">
          New services start with no price — after adding, set each branch&apos;s price straight
          from the table, or the service shows as &ldquo;not offered&rdquo;.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Service name" error={error ?? undefined}>
            <Input value={name} autoFocus invalid={!!error}
              onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">—</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Company share (%)">
            <Input inputMode="numeric" value={ratePct}
              onChange={(e) => setRatePct(e.target.value)} />
          </Field>
          <Field label="Duration (min)">
            <Input inputMode="numeric" value={duration}
              onChange={(e) => setDuration(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>
            Add service
          </Button>
        </div>
      </Modal>
    </>
  );
}

function AddServiceTypeButton({ businessId, onChanged }: {
  businessId: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (name.trim() === "") { setError("The type needs a name."); return; }
    setBusy(true);
    setError(null);
    const { error } = await createClient().from("service_types").insert({
      name: name.trim(),
      business_id: businessId,
      sort_order: 99,
    });
    setBusy(false);
    if (error) {
      setError(/unique/i.test(error.message)
        ? "That type already exists for this business."
        : "The type was not added. Try again.");
      return;
    }
    setName("");
    setOpen(false);
    onChanged();
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Add service type</Button>
      <Modal title="Add service type" open={open} onClose={() => setOpen(false)}>
        <Field label="Type name" error={error ?? undefined}>
          <Input value={name} autoFocus invalid={!!error}
            onChange={(e) => setName(e.target.value)} placeholder="e.g. Massage" />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>
            Add type
          </Button>
        </div>
      </Modal>
    </>
  );
}

function PriceModal({ editing, onClose, onDone }: {
  editing: { service: Service; branch: Branch; current: number | null } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editing) return;
    const cents = parsePesos(input);
    if (cents == null || cents < 0) {
      setError("Enter the price in pesos.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().from("branch_service_prices").upsert(
      {
        branch_id: editing.branch.id,
        service_id: editing.service.id,
        price_cents: cents,
        effective_from: new Date().toLocaleDateString("sv-SE"),
      },
      { onConflict: "branch_id,service_id,effective_from" },
    );
    setBusy(false);
    if (error) {
      setError("The price was not saved. Try again.");
      return;
    }
    setInput("");
    onDone();
  }

  return (
    <Modal
      title={editing ? `${editing.service.name} at ${editing.branch.name}` : ""}
      open={editing != null}
      onClose={onClose}
    >
      <p className="mb-4 text-[13px] text-text-muted">
        Current: {editing?.current != null ? formatCentavos(editing.current) : "not offered"} ·
        the new price takes effect today, history keeps the old one.
      </p>
      <Field label="New price (₱)" error={error ?? undefined}>
        <Input inputMode="decimal" value={input} autoFocus invalid={!!error}
          onChange={(e) => setInput(e.target.value)} />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

// Name, type, company share and duration in one place. Renaming applies
// everywhere — past reports show the new name because it is the same
// service. Share and duration touch new tickets only; prices are edited
// per branch in the table, and history is never rewritten.
function EditServiceModal({ service, types, onClose, onDone }: {
  service: Service | null;
  types: ServiceType[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [ratePct, setRatePct] = useState("");
  const [duration, setDuration] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (service && loadedFor !== service.id) {
    setName(service.name);
    setTypeId(service.service_type_id);
    setRatePct((Number(service.default_sharing_rate) * 100).toFixed(0));
    setDuration(String(service.default_duration_min));
    setLoadedFor(service.id);
    setError(null);
  }

  async function save() {
    if (!service) return;
    const pct = Number(ratePct);
    const mins = Number(duration);
    if (name.trim() === "") { setError("The service needs a name."); return; }
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError("Company share must be 0 to 100."); return;
    }
    if (!Number.isFinite(mins) || mins <= 0) {
      setError("Duration must be a positive number of minutes."); return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient()
      .from("services")
      .update({
        name: name.trim(),
        service_type_id: typeId,
        default_sharing_rate: (pct / 100).toFixed(3),
        default_duration_min: mins,
      })
      .eq("id", service.id);
    setBusy(false);
    if (error) {
      setError(/unique/i.test(error.message)
        ? "Another service under this type already has that name."
        : "The service was not saved. Try again.");
      return;
    }
    onDone();
  }

  return (
    <Modal title={service ? `Edit ${service.name}` : ""} open={service != null} onClose={onClose}>
      <p className="mb-4 text-[13px] text-text-muted">
        Renaming applies everywhere, including past reports — it is the same service. The share
        and duration apply to new tickets only; past lines keep what they were sold at. Prices
        are edited per branch, straight from the table.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Service name" error={error ?? undefined}>
          <Input value={name} autoFocus invalid={!!error}
            onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Company share (%)">
          <Input inputMode="numeric" value={ratePct}
            onChange={(e) => setRatePct(e.target.value)} />
        </Field>
        <Field label="Duration (min)">
          <Input inputMode="numeric" value={duration}
            onChange={(e) => setDuration(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

// The action lives in its own column, away from the Status text, and a
// confirm modal guards the flip — a stray click must not silently retire
// or restore anything.
function ToggleActive({ table, id, name, active, onChanged }: {
  table: "services" | "technicians";
  id: string;
  name: string;
  active: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    await createClient().from(table).update({ active: !active }).eq("id", id);
    setBusy(false);
    setConfirming(false);
    onChanged();
  }

  return (
    <>
      <button
        className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-body hover:underline"
        title={active ? `Retire ${name}` : `Restore ${name}`}
        aria-label={active ? `Retire ${name}` : `Restore ${name}`}
        onClick={() => setConfirming(true)}
      >
        {active ? <Archive size={14} /> : <ArchiveRestore size={14} />}
        {active ? "Retire" : "Restore"}
      </button>
      <Modal
        title={active ? `Retire ${name}?` : `Restore ${name}?`}
        open={confirming}
        onClose={() => setConfirming(false)}
      >
        <p className="mb-4 text-[13px] text-text-muted">
          {active
            ? "Retired items disappear from new-ticket pickers. History keeps them, and they can be restored here any time."
            : "Restoring makes it available again when entering new tickets."}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void apply()}>
            {active ? "Retire" : "Restore"}
          </Button>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Products (inventory catalogue)
// ---------------------------------------------------------------------------

interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  brand: string | null;
  size: string | null;
  unit: string;
  category_id: string | null;
  subcategory_id: string | null;
  standard_cost_cents: number | null;
  retail_price_cents: number | null;
  low_stock_threshold: number;
  active: boolean;
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
}

const PRODUCT_ACC: Record<string, (p: ProductRow & { catLabel: string }) => unknown> = {
  sku: (p) => p.sku,
  name: (p) => p.name,
  brand: (p) => p.brand,
  category: (p) => p.catLabel,
  size: (p) => p.size,
  cost: (p) => p.standard_cost_cents,
  retail: (p) => p.retail_price_cents,
  threshold: (p) => p.low_stock_threshold,
  status: (p) => (p.active ? "Active" : "Retired"),
};

function ProductsTab() {
  const { businessId } = useSession();
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "retired">("active");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [toggling, setToggling] = useState<ProductRow | null>(null);

  const q = useQuery(async () => {
    const supabase = createClient();
    const [products, categories] = await Promise.all([
      supabase
        .from("products")
        .select("id, sku, name, brand, size, unit, category_id, subcategory_id, standard_cost_cents, retail_price_cents, low_stock_threshold, active")
        .eq("business_id", businessId)
        .order("name"),
      supabase
        .from("product_categories")
        .select("id, parent_id, name")
        .eq("business_id", businessId)
        .order("name"),
    ]);
    return {
      products: unwrap(products) as ProductRow[],
      categories: unwrap(categories) as CategoryRow[],
    };
  }, [businessId]);

  const categories = q.status === "ready" ? q.data.categories : [];
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  const filtered = q.status === "ready"
    ? q.data.products
        .filter((p) =>
          statusFilter === "" ? true : statusFilter === "active" ? p.active : !p.active)
        .filter((p) => categoryFilter === "" || p.category_id === categoryFilter)
        .filter((p) => {
          const s = search.trim().toLowerCase();
          if (s === "") return true;
          return [p.name, p.brand, p.sku].some((v) => v?.toLowerCase().includes(s));
        })
        .map((p) => ({
          ...p,
          catLabel: [
            p.category_id ? catName.get(p.category_id) : null,
            p.subcategory_id ? catName.get(p.subcategory_id) : null,
          ].filter(Boolean).join(" › "),
        }))
    : null;
  const { rows, th } = useSort(filtered, PRODUCT_ACC);

  return (
    <Card title="Products">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="w-56 shrink-0">
          <Input placeholder="Search name, brand or SKU" value={search}
            aria-label="Search products"
            onChange={(e) => setSearch(e.target.value)} />
        </span>
        <Select value={categoryFilter} className="w-44" aria-label="Category filter"
          onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="">All categories</option>
          {categories.filter((c) => c.parent_id == null).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        <Select value={statusFilter} className="w-32" aria-label="Status filter"
          onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "retired")}>
          <option value="active">Active</option>
          <option value="retired">Retired</option>
          <option value="">All</option>
        </Select>
        <span className="ml-auto">
          <Button variant="primary" onClick={() => setAdding(true)}>Add product</Button>
        </span>
      </div>
      <p className="mb-3 text-[11px] text-text-muted">
        The inventory catalogue. Categories and sub-categories are created
        right inside the product form. Stock levels live on the Inventory
        page; retiring a product hides it from new movements without touching
        its history.
      </p>

      {q.status === "loading" && <SkeletonRows rows={4} cols={8} />}
      {q.status === "error" && <ErrorState message="Products did not load." onRetry={q.retry} />}
      {rows != null && rows.length === 0 && (
        <EmptyState message={search.trim() !== "" || categoryFilter !== ""
          ? "No products match these filters."
          : statusFilter === "retired"
            ? "No retired products."
            : "No products yet. Add the consumables you want tracked."} />
      )}
      {rows != null && rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th {...th("sku")}>SKU</Th>
              <Th {...th("name")}>Product</Th>
              <Th {...th("brand")}>Brand</Th>
              <Th {...th("category")}>Category</Th>
              <Th {...th("size")}>Size</Th>
              <Th align="right" {...th("cost")}>Unit cost</Th>
              <Th align="right" {...th("retail")}>Retail</Th>
              <Th align="right" {...th("threshold")}>Alert</Th>
              <Th {...th("status")}>Status</Th>
              <Th align="right"></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                <Td className="tnum">{p.sku ?? "—"}</Td>
                <Td className="font-bold"><Truncate text={p.name} max={28} /></Td>
                <Td><Truncate text={p.brand ?? "—"} max={16} /></Td>
                <Td><Truncate text={p.catLabel || "—"} max={24} /></Td>
                <Td>{p.size ?? "—"}</Td>
                <Td align="right" className="tnum">
                  {p.standard_cost_cents != null ? formatCentavos(p.standard_cost_cents) : "—"}
                </Td>
                <Td align="right" className="tnum">
                  {p.retail_price_cents != null ? formatCentavos(p.retail_price_cents) : "—"}
                </Td>
                <Td align="right" className="tnum">
                  {p.low_stock_threshold > 0 ? `at ${p.low_stock_threshold}` : "—"}
                </Td>
                <Td>{p.active ? "Active" : <span className="text-text-muted">Retired</span>}</Td>
                <Td align="right">
                  <span className="flex items-center justify-end gap-3">
                    <button className="text-[11px] hover:underline"
                      onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    <button
                      className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-body hover:underline"
                      onClick={() => setToggling(p)}
                    >
                      {p.active ? <Archive size={14} /> : <ArchiveRestore size={14} />}
                      {p.active ? "Retire" : "Restore"}
                    </button>
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <ProductModal
        open={adding || editing != null}
        product={editing}
        categories={categories}
        businessId={businessId}
        onClose={() => { setAdding(false); setEditing(null); }}
        onDone={() => { setAdding(false); setEditing(null); q.retry(); }}
      />
      <ProductToggleModal
        product={toggling}
        onClose={() => setToggling(null)}
        onDone={() => { setToggling(null); q.retry(); }}
      />
    </Card>
  );
}

/** Sentinel option value: the user is typing a brand-new category name. */
const NEW_CATEGORY = "__new__";

function ProductModal({ open, product, categories, businessId, onClose, onDone }: {
  open: boolean;
  product: ProductRow | null;
  categories: CategoryRow[];
  businessId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [size, setSize] = useState("");
  const [unit, setUnit] = useState("pc");
  const [categoryId, setCategoryId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [newSubcategory, setNewSubcategory] = useState("");
  const [costInput, setCostInput] = useState("");
  const [retailInput, setRetailInput] = useState("");
  const [thresholdInput, setThresholdInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSku(product?.sku ?? "");
    setName(product?.name ?? "");
    setBrand(product?.brand ?? "");
    setSize(product?.size ?? "");
    setUnit(product?.unit ?? "pc");
    setCategoryId(product?.category_id ?? "");
    setNewCategory("");
    setSubcategoryId(product?.subcategory_id ?? "");
    setNewSubcategory("");
    setCostInput(product?.standard_cost_cents != null
      ? String(product.standard_cost_cents / 100) : "");
    setRetailInput(product?.retail_price_cents != null
      ? String(product.retail_price_cents / 100) : "");
    setThresholdInput(product && product.low_stock_threshold > 0
      ? String(product.low_stock_threshold) : "");
    setError(null);
    setBusy(false);
  }, [open, product]);

  const topCategories = categories.filter((c) => c.parent_id == null);
  const subcategories = categoryId !== "" && categoryId !== NEW_CATEGORY
    ? categories.filter((c) => c.parent_id === categoryId)
    : [];

  async function submit() {
    const trimmed = name.trim();
    const threshold = thresholdInput === "" ? 0 : Number(thresholdInput);
    const cost = costInput.trim() === "" ? null : parsePesos(costInput);
    const retail = retailInput.trim() === "" ? null : parsePesos(retailInput);
    if (trimmed === "") { setError("The product needs a name."); return; }
    if (unit.trim() === "") { setError("The unit is required — bottle, sachet, pc…"); return; }
    if (costInput.trim() !== "" && (cost == null || cost < 0)) {
      setError("Unit cost must be a peso amount, or blank."); return;
    }
    if (retailInput.trim() !== "" && (retail == null || retail < 0)) {
      setError("Retail price must be a peso amount, or blank."); return;
    }
    if (!Number.isInteger(threshold) || threshold < 0) {
      setError("The low-stock alert must be a whole number, or blank for none."); return;
    }
    if (categoryId === NEW_CATEGORY && newCategory.trim() === "") {
      setError("Type the new category's name."); return;
    }
    if (subcategoryId === NEW_CATEGORY && newSubcategory.trim() === "") {
      setError("Type the new sub-category's name."); return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();

    // Inline category creation: brand-new names become rows first, so
    // nobody ever needs a developer to grow the category list.
    let catId: string | null = categoryId === "" ? null : categoryId;
    if (categoryId === NEW_CATEGORY) {
      const { data, error: err } = await supabase
        .from("product_categories")
        .insert({ business_id: businessId, name: newCategory.trim() })
        .select("id")
        .single();
      if (err) {
        setBusy(false);
        setError(/duplicate|unique/i.test(err.message)
          ? "A category with that name already exists."
          : "The category was not saved. Try again.");
        return;
      }
      catId = (data as { id: string }).id;
    }
    let subId: string | null =
      subcategoryId === "" || catId == null ? null : subcategoryId;
    if (subcategoryId === NEW_CATEGORY && catId != null) {
      const { data, error: err } = await supabase
        .from("product_categories")
        .insert({ business_id: businessId, parent_id: catId, name: newSubcategory.trim() })
        .select("id")
        .single();
      if (err) {
        setBusy(false);
        setError(/duplicate|unique/i.test(err.message)
          ? "A sub-category with that name already exists here."
          : "The sub-category was not saved. Try again.");
        return;
      }
      subId = (data as { id: string }).id;
    }

    const values = {
      sku: sku.trim() || null,
      name: trimmed,
      brand: brand.trim() || null,
      size: size.trim() || null,
      unit: unit.trim(),
      category_id: catId,
      subcategory_id: subId,
      standard_cost_cents: cost,
      retail_price_cents: retail,
      low_stock_threshold: threshold,
    };
    const { error: err } = product
      ? await supabase.from("products").update(values).eq("id", product.id)
      : await supabase.from("products").insert({ ...values, business_id: businessId });
    setBusy(false);
    if (err) {
      setError(/products_sku_key/i.test(err.message)
        ? "That SKU is already used by another product."
        : /duplicate|unique/i.test(err.message)
          ? "A product with this name, brand and size already exists."
          : "The product was not saved. Try again.");
      return;
    }
    onDone();
  }

  return (
    <Modal title={product ? `Edit ${product.name}` : "Add product"} open={open} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <Field label="SKU" hint="Blank — assigned automatically">
            <Input value={sku} className="w-32" onChange={(e) => setSku(e.target.value)} />
          </Field>
          <Field label="Name">
            <Input value={name} className="w-64" autoFocus
              onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="Brand">
            <Input value={brand} className="w-40" onChange={(e) => setBrand(e.target.value)} />
          </Field>
          <Field label="Size" hint="e.g. 1 L, 500 mL">
            <Input value={size} className="w-28" onChange={(e) => setSize(e.target.value)} />
          </Field>
          <Field label="Unit" hint="bottle, sachet, pc…">
            <Input value={unit} className="w-28" onChange={(e) => setUnit(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="Category">
            <Select value={categoryId} className="w-44"
              onChange={(e) => {
                setCategoryId(e.target.value);
                setSubcategoryId("");
                setNewSubcategory("");
              }}>
              <option value="">No category</option>
              {topCategories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value={NEW_CATEGORY}>+ Add new category…</option>
            </Select>
          </Field>
          {categoryId === NEW_CATEGORY && (
            <Field label="New category name">
              <Input value={newCategory} className="w-44"
                onChange={(e) => setNewCategory(e.target.value)} />
            </Field>
          )}
          {categoryId !== "" && categoryId !== NEW_CATEGORY && (
            <Field label="Sub-category">
              <Select value={subcategoryId} className="w-44"
                onChange={(e) => setSubcategoryId(e.target.value)}>
                <option value="">No sub-category</option>
                {subcategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value={NEW_CATEGORY}>+ Add new sub-category…</option>
              </Select>
            </Field>
          )}
          {subcategoryId === NEW_CATEGORY && (
            <Field label="New sub-category name">
              <Input value={newSubcategory} className="w-44"
                onChange={(e) => setNewSubcategory(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="Unit cost (₱)" hint="Pre-fills deliveries">
            <Input inputMode="decimal" value={costInput} className="w-28"
              onChange={(e) => setCostInput(e.target.value)} />
          </Field>
          <Field label="Retail price (₱)" hint="If sold to clients">
            <Input inputMode="decimal" value={retailInput} className="w-28"
              onChange={(e) => setRetailInput(e.target.value)} />
          </Field>
          <Field label="Low-stock alert" hint="Blank for none">
            <Input inputMode="numeric" value={thresholdInput} className="w-28"
              onChange={(e) => setThresholdInput(e.target.value)} />
          </Field>
        </div>
        {error && <p className="text-[11px] text-brand-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void submit()}>
            {product ? "Save changes" : "Add product"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProductToggleModal({ product, onClose, onDone }: {
  product: ProductRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function apply() {
    if (!product) return;
    setBusy(true);
    await createClient().from("products")
      .update({ active: !product.active }).eq("id", product.id);
    setBusy(false);
    onDone();
  }

  return (
    <Modal
      title={product?.active ? `Retire ${product?.name}?` : `Restore ${product?.name}?`}
      open={product != null}
      onClose={onClose}
    >
      <p className="mb-4 text-[13px] text-text-muted">
        {product?.active
          ? "A retired product stops appearing in movement dialogs. Its stock history stays on record."
          : "The product becomes available again for deliveries, usage and transfers."}
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void apply()}>
          {product?.active ? "Retire" : "Restore"}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Costing — true cost and margin per service (phase 1)
// ---------------------------------------------------------------------------

interface CostingRow {
  service_id: string;
  service_name: string;
  service_type_name: string;
  active: boolean;
  price_cents: number | null;
  sharing_rate: number;
  product_cost_cents: number;
  recipe_items: number;
  unpriced_items: number;
  duration_min: number;
  duration_source: "timed" | "standard";
  treatments_90d: number;
  realized_price_cents: number | null;
}

interface CostingComputed extends CostingRow {
  labor_cents: number | null;
  overhead_cents: number;
  cost_cents: number | null;
  margin_cents: number | null;
  margin_pct: number | null;
  contribution_cents: number | null;
}

const COSTING_ACC: Record<string, (r: CostingComputed) => unknown> = {
  service: (r) => r.service_name,
  type: (r) => r.service_type_name,
  price: (r) => r.price_cents,
  labor: (r) => r.labor_cents,
  products: (r) => r.product_cost_cents,
  overhead: (r) => r.overhead_cents,
  cost: (r) => r.cost_cents,
  margin: (r) => r.margin_cents,
  pct: (r) => r.margin_pct,
  contrib: (r) => r.contribution_cents,
};

function CostingTab({ branches }: { branches: Branch[] }) {
  const { branchId } = useSession();
  const [branch, setBranch] = useState(branchId ?? branches[0]?.id ?? "");
  const [nonce, setNonce] = useState(0);
  const [recipeFor, setRecipeFor] = useState<CostingRow | null>(null);
  // What-if prices, keyed by service id; peso text as typed.
  const [whatIf, setWhatIf] = useState<Record<string, string>>({});
  useEffect(() => { setWhatIf({}); }, [branch]);

  const q = useQuery(async () => {
    const supabase = createClient();
    const [rows, basis, suggestion, settings] = await Promise.all([
      supabase.rpc("f_service_costing", { p_branch: branch }),
      supabase.rpc("f_costing_basis", { p_branch: branch }),
      supabase.rpc("f_overhead_suggestion", { p_branch: branch }),
      supabase.from("costing_settings").select("*").eq("branch_id", branch).maybeSingle(),
    ]);
    return {
      rows: (unwrap(rows) as CostingRow[]).filter((r) => r.active),
      monthlyMinutes: Number((unwrap(basis) as { monthly_minutes: number }[])[0]?.monthly_minutes ?? 0),
      suggestions: unwrap(suggestion) as { category: string; monthly_avg_cents: number }[],
      settings: settings.data as {
        monthly_overhead_cents: number;
        monthly_minutes_override: number | null;
      } | null,
    };
  }, [branch, nonce]);

  const pool = q.status === "ready" ? q.data.settings?.monthly_overhead_cents ?? 0 : 0;
  const minutes = q.status === "ready"
    ? q.data.settings?.monthly_minutes_override ?? q.data.monthlyMinutes
    : 0;
  const ohRate = minutes > 0 ? pool / minutes : 0; // centavos per minute

  const computed: CostingComputed[] | null = q.status === "ready"
    ? q.data.rows.map((r) => {
        const priceInput = whatIf[r.service_id];
        const price = priceInput != null && priceInput.trim() !== ""
          ? parsePesos(priceInput)
          : r.price_cents;
        const overhead = Math.round(r.duration_min * ohRate);
        if (price == null) {
          return {
            ...r, labor_cents: null, overhead_cents: overhead, cost_cents: null,
            margin_cents: null, margin_pct: null, contribution_cents: null,
          };
        }
        const labor = Math.round(price * Number(r.sharing_rate));
        const cost = labor + r.product_cost_cents + overhead;
        const margin = price - cost;
        return {
          ...r,
          labor_cents: labor,
          overhead_cents: overhead,
          cost_cents: cost,
          margin_cents: margin,
          margin_pct: price > 0 ? (margin / price) * 100 : null,
          contribution_cents: Math.round((margin * r.treatments_90d) / 3),
        };
      })
    : null;

  const { rows, th } = useSort(computed, COSTING_ACC);

  return (
    <div className="space-y-6">
      <Card title="Costing assumptions">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          {branches.length > 1 && (
            <Field label="Branch">
              <Select value={branch} className="w-40"
                onChange={(e) => setBranch(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </Select>
            </Field>
          )}
          {q.status === "ready" && (
            <AssumptionsEditor
              key={branch}
              branch={branch}
              settings={q.data.settings}
              computedMinutes={q.data.monthlyMinutes}
              onSaved={() => setNonce((n) => n + 1)}
            />
          )}
        </div>
        {q.status === "ready" && (
          <p className="text-[11px] text-text-muted">
            Serviced minutes measured from actual treatments (90-day average):{" "}
            {Math.round(q.data.monthlyMinutes).toLocaleString()} per month — leave the
            field blank to use it.
            {" "}The overhead pool is the branch&apos;s fixed monthly running cost: rent,
            fixed salaries, and anything else the app does not see. For reference,
            the expense ledger averaged per month (last 3 full months):{" "}
            {q.data.suggestions.length === 0
              ? "no expenses recorded yet."
              : q.data.suggestions.map((s) =>
                  `${s.category} ${formatCentavos(s.monthly_avg_cents)}`).join(" · ") + "."}
            {" "}Leave allowance/withdrawal categories out — technician pay is
            already counted as labor, and withdrawals are not costs.
          </p>
        )}
      </Card>

      <Card title="True cost and margin per service">
        {q.status === "loading" && <SkeletonRows rows={8} cols={9} />}
        {q.status === "error" && (
          <ErrorState message="Costing did not load." onRetry={q.retry} />
        )}
        {q.status === "ready" && pool === 0 && (
          <p className="mb-3 text-[11px] text-brand-red">
            The overhead pool is ₱0 — margins below ignore rent and fixed costs
            until it is set above.
          </p>
        )}
        {rows != null && rows.length === 0 && (
          <EmptyState message="No active services for this branch's business." />
        )}
        {rows != null && rows.length > 0 && (
          <>
            <Table>
              <thead>
                <tr>
                  <Th {...th("service")}>Service</Th>
                  <Th align="right" {...th("price")}>Price</Th>
                  <Th align="right" {...th("labor")}>Labor</Th>
                  <Th align="right" {...th("products")}>Products</Th>
                  <Th align="right" {...th("overhead")}>Overhead</Th>
                  <Th align="right" {...th("cost")}>True cost</Th>
                  <Th align="right" {...th("margin")}>Margin</Th>
                  <Th align="right" {...th("pct")}>Margin %</Th>
                  <Th align="right" {...th("contrib")}>Contrib./mo</Th>
                  <Th align="right">What-if ₱</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const thin = r.margin_pct != null && r.margin_pct < 20;
                  const negative = r.margin_cents != null && r.margin_cents < 0;
                  return (
                    <tr key={r.service_id}>
                      <Td>
                        <span className="font-bold"><Truncate text={r.service_name} max={26} /></span>
                        <span className="block text-[11px] text-text-muted">
                          {r.service_type_name} · {r.duration_min} min
                          {r.duration_source === "timed" ? " (timed)" : ""}
                        </span>
                      </Td>
                      <Td align="right" className="tnum">
                        {r.price_cents != null ? formatCentavos(r.price_cents) : (
                          <span className="text-text-muted">no price</span>
                        )}
                        {r.realized_price_cents != null &&
                          r.price_cents != null &&
                          r.realized_price_cents !== r.price_cents && (
                          <span className="block text-[11px] text-text-muted">
                            realized {formatCentavos(r.realized_price_cents)}
                          </span>
                        )}
                      </Td>
                      <Td align="right" className="tnum">
                        {r.labor_cents != null ? formatCentavos(r.labor_cents) : "—"}
                      </Td>
                      <Td align="right" className="tnum">
                        {r.recipe_items === 0 ? (
                          <span className="text-text-muted" title="No recipe yet">—</span>
                        ) : (
                          <>
                            {formatCentavos(r.product_cost_cents)}
                            {r.unpriced_items > 0 && (
                              <span
                                className="ml-1 text-brand-red"
                                title={`${r.unpriced_items} recipe item(s) have no cost yet`}
                              >
                                ⚠
                              </span>
                            )}
                          </>
                        )}
                      </Td>
                      <Td align="right" className="tnum">{formatCentavos(r.overhead_cents)}</Td>
                      <Td align="right" className="tnum">
                        {r.cost_cents != null ? formatCentavos(r.cost_cents) : "—"}
                      </Td>
                      <Td align="right"
                        className={`tnum font-bold${negative ? " text-brand-red" : ""}`}>
                        {r.margin_cents != null ? formatCentavos(r.margin_cents) : "—"}
                      </Td>
                      <Td align="right"
                        className={`tnum${negative ? " font-bold text-brand-red" : thin ? " text-brand-red" : ""}`}>
                        {r.margin_pct != null ? `${r.margin_pct.toFixed(1)}%` : "—"}
                      </Td>
                      <Td align="right" className="tnum">
                        {r.contribution_cents != null && r.treatments_90d > 0
                          ? formatCentavos(r.contribution_cents)
                          : "—"}
                      </Td>
                      <Td align="right">
                        <span className="inline-block w-20">
                          <Input inputMode="decimal" className="h-7 w-20 text-right tnum"
                            value={whatIf[r.service_id] ?? ""}
                            aria-label={`What-if price for ${r.service_name}`}
                            onChange={(e) => setWhatIf((w) => ({
                              ...w, [r.service_id]: e.target.value,
                            }))} />
                        </span>
                      </Td>
                      <Td align="right">
                        <button className="text-[11px] hover:underline"
                          onClick={() => setRecipeFor(r)}>
                          Recipe{r.recipe_items > 0 ? ` (${r.recipe_items})` : ""}
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <p className="mt-2 text-[11px] text-text-muted">
              Labor = the technician share actually paid. Products = the
              service&apos;s recipe at delivered average cost. Overhead ={" "}
              {minutes > 0
                ? `duration × ${formatCentavos(Math.round(ohRate))} per serviced minute (₱${Math.round(pool / 100).toLocaleString()} pool ÷ ${Math.round(minutes).toLocaleString()} minutes/month)`
                : "not absorbed yet — no serviced minutes recorded"}.
              Contribution = margin × last 90 days&apos; volume ÷ 3. A red margin
              is negative; a red percentage is under 20%. Type a what-if price
              to preview a re-price.
            </p>
          </>
        )}
      </Card>

      <RecipeModal
        row={recipeFor}
        onClose={() => setRecipeFor(null)}
        onDone={() => { setRecipeFor(null); setNonce((n) => n + 1); }}
      />
    </div>
  );
}

function AssumptionsEditor({ branch, settings, computedMinutes, onSaved }: {
  branch: string;
  settings: { monthly_overhead_cents: number; monthly_minutes_override: number | null } | null;
  computedMinutes: number;
  onSaved: () => void;
}) {
  const [poolInput, setPoolInput] = useState(
    settings != null && settings.monthly_overhead_cents > 0
      ? String(settings.monthly_overhead_cents / 100) : "");
  const [minutesInput, setMinutesInput] = useState(
    settings?.monthly_minutes_override != null
      ? String(settings.monthly_minutes_override) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const pool = poolInput.trim() === "" ? 0 : parsePesos(poolInput);
    const override = minutesInput.trim() === "" ? null : Number(minutesInput);
    if (pool == null || pool < 0) {
      setError("The overhead pool must be a peso amount.");
      return;
    }
    if (override != null && (!Number.isInteger(override) || override <= 0)) {
      setError("Minutes must be a whole number, or blank to use the measured figure.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await createClient()
      .from("costing_settings")
      .upsert({
        branch_id: branch,
        monthly_overhead_cents: pool,
        monthly_minutes_override: override,
        updated_at: new Date().toISOString(),
      });
    setBusy(false);
    if (err) {
      setError("The assumptions were not saved. Try again.");
      return;
    }
    onSaved();
  }

  return (
    <>
      <Field label="Monthly overhead pool (₱)" error={error ?? undefined}>
        <Input inputMode="decimal" value={poolInput} className="w-36"
          invalid={!!error}
          onChange={(e) => setPoolInput(e.target.value)} />
      </Field>
      {/* No hint here on purpose: an always-visible hint makes this field
          taller than its row siblings and breaks the bottom alignment. The
          measured figure shows as the placeholder and in the note below. */}
      <Field label="Serviced minutes / month">
        <Input inputMode="numeric" value={minutesInput} className="w-36"
          placeholder={String(Math.round(computedMinutes))}
          onChange={(e) => setMinutesInput(e.target.value)} />
      </Field>
      <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void save()}>
        Save assumptions
      </Button>
    </>
  );
}

interface RecipeItem {
  id: string;
  qty: number;
  product_id: string;
  products: { name: string; brand: string | null; size: string | null; unit: string } | null;
}

function RecipeModal({ row, onClose, onDone }: {
  row: CostingRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { businessId } = useSession();
  const [items, setItems] = useState<RecipeItem[] | null>(null);
  const [products, setProducts] = useState<{ id: string; label: string }[]>([]);
  const [productId, setProductId] = useState("");
  const [qtyInput, setQtyInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!row) return;
    setItems(null);
    setProductId("");
    setQtyInput("");
    setError(null);
    setDirty(false);
    let alive = true;
    void (async () => {
      const supabase = createClient();
      const [recipe, prods] = await Promise.all([
        supabase
          .from("service_recipes")
          .select("id, qty, product_id, products(name, brand, size, unit)")
          .eq("service_id", row.service_id)
          .order("created_at"),
        supabase
          .from("products")
          .select("id, name, brand, size, unit")
          .eq("business_id", businessId)
          .eq("active", true)
          .order("name"),
      ]);
      if (!alive) return;
      setItems((recipe.data ?? []) as unknown as RecipeItem[]);
      setProducts(((prods.data ?? []) as {
        id: string; name: string; brand: string | null; size: string | null; unit: string;
      }[]).map((p) => ({
        id: p.id,
        label: `${p.name}${p.brand ? ` — ${p.brand}` : ""}${p.size ? `, ${p.size}` : ""} (${p.unit})`,
      })));
    })();
    return () => { alive = false; };
  }, [row, businessId]);

  async function addItem() {
    if (!row) return;
    const qty = Number(qtyInput);
    if (!productId) { setError("Pick a product."); return; }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Quantity per treatment must be above zero — fractions like 0.25 are fine.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await createClient().from("service_recipes").insert({
      service_id: row.service_id,
      product_id: productId,
      qty,
    });
    setBusy(false);
    if (err) {
      setError(/duplicate|unique/i.test(err.message)
        ? "That product is already in the recipe — remove it first to change the quantity."
        : "The item was not added. Try again.");
      return;
    }
    setDirty(true);
    setProductId("");
    setQtyInput("");
    const { data } = await createClient()
      .from("service_recipes")
      .select("id, qty, product_id, products(name, brand, size, unit)")
      .eq("service_id", row.service_id)
      .order("created_at");
    setItems((data ?? []) as unknown as RecipeItem[]);
  }

  async function removeItem(id: string) {
    await createClient().from("service_recipes").delete().eq("id", id);
    setDirty(true);
    setItems((it) => it?.filter((i) => i.id !== id) ?? null);
  }

  function close() {
    if (dirty) onDone(); else onClose();
  }

  return (
    <Modal title={`Recipe — ${row?.service_name ?? ""}`} open={row != null} onClose={close}>
      <p className="mb-4 text-[13px] text-text-muted">
        What one treatment consumes. Costed at the delivered average price
        (falling back to the product&apos;s standard cost). Fractions are fine —
        0.25 means a quarter of a unit per treatment.
      </p>
      {items == null && <SkeletonRows rows={2} cols={3} />}
      {items != null && items.length > 0 && (
        <Table>
          <thead>
            <tr><Th>Product</Th><Th align="right">Qty / treatment</Th><Th></Th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <Td>
                  <Truncate
                    text={i.products
                      ? `${i.products.name}${i.products.brand ? ` — ${i.products.brand}` : ""}${i.products.size ? `, ${i.products.size}` : ""}`
                      : "?"}
                    max={36}
                  />
                </Td>
                <Td align="right" className="tnum">
                  {Number(i.qty)} {i.products?.unit ?? ""}
                </Td>
                <Td align="right">
                  <button className="text-[11px] text-brand-red hover:underline"
                    onClick={() => void removeItem(i.id)}>
                    Remove
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {items != null && items.length === 0 && (
        <p className="mb-2 text-[13px] text-text-muted">No recipe yet.</p>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Field label="Product">
          <Select value={productId} className="w-64"
            onChange={(e) => setProductId(e.target.value)}>
            <option value="">Pick a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Qty / treatment">
          <Input inputMode="decimal" value={qtyInput} className="w-24"
            onChange={(e) => setQtyInput(e.target.value)} />
        </Field>
        <Button busy={busy} busyLabel="Adding" onClick={() => void addItem()}>
          Add item
        </Button>
      </div>
      {error && <p className="mt-2 text-[11px] text-brand-red">{error}</p>}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={close}>Done</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Technicians
// ---------------------------------------------------------------------------

interface RosterRow { t: Technician; branchName: string }

const SKILL_LABEL: Record<string, string> = {
  trainee: "Trainee", junior: "Junior", senior: "Senior", master: "Master",
};

const SPECIALTY_SUGGESTIONS = [
  "Hairdresser", "Barber", "Nail technician", "Lash technician",
  "Brow technician", "Massage therapist", "Aesthetician",
];

const ROSTER_ACC: Record<string, (r: RosterRow) => unknown> = {
  name: (r) => r.t.full_name,
  branch: (r) => r.branchName,
  specialty: (r) => r.t.specialty,
  skill: (r) => r.t.skill_level,
  hired: (r) => r.t.hired_on,
  status: (r) => (r.t.active ? "Active" : "Retired"),
};

function TechniciansTab({ branches }: { branches: Branch[] }) {
  const { branchId } = useSession();
  const [addOpen, setAddOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "retired">("active");

  const q = useQuery(async () => {
    const res = await createClient().from("technicians").select("*").order("full_name");
    return unwrap(res) as Technician[];
  }, []);

  // The header's branch switcher filters the roster like everywhere else.
  const rosterRows = useMemo(() => {
    if (q.status !== "ready") return null;
    return q.data
      .filter((t) => !branchId || t.branch_id === branchId)
      .filter((t) =>
        statusFilter === "" ? true : statusFilter === "active" ? t.active : !t.active)
      .map((t): RosterRow => ({
        t,
        branchName: branches.find((b) => b.id === t.branch_id)?.name ?? "—",
      }));
  }, [q.status, q.data, branches, branchId, statusFilter]);
  const { rows, th } = useSort(rosterRows, ROSTER_ACC);

  return (
    <Card title="Technicians">
      <p className="mb-4 text-[11px] text-text-muted">
        Retiring a technician removes them from new-ticket pickers; their history stays
        (edge case: staff who leave mid-month).
      </p>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <Button variant="primary" onClick={() => setAddOpen(true)}>Add technician</Button>
        <Field label="Status">
          <Select value={statusFilter} className="w-32"
            onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "retired")}>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
            <option value="">All</option>
          </Select>
        </Field>
      </div>

      {q.status === "loading" && <SkeletonRows rows={6} cols={3} />}
      {q.status === "error" && <ErrorState message="Technicians did not load." onRetry={q.retry} />}
      {rows != null && rows.length === 0 && (
        <EmptyState message="No technicians match this branch and status." />
      )}
      {rows != null && rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th {...th("name")}>Name</Th>
              <Th {...th("branch")}>Branch</Th>
              <Th {...th("specialty")}>Type</Th>
              <Th {...th("skill")}>Skill level</Th>
              <Th {...th("hired")}>Hired</Th>
              <Th {...th("status")}>Status</Th>
              <Th align="right">Status toggle</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, branchName }) => (
              <tr key={t.id} className={t.active ? "" : "opacity-50"}>
                <Td className="font-bold"><Truncate text={t.full_name} /></Td>
                <Td>{branchName}</Td>
                <Td>{t.specialty ?? "—"}</Td>
                <Td>{t.skill_level ? SKILL_LABEL[t.skill_level] : "—"}</Td>
                <Td className="tnum">{t.hired_on ?? "—"}</Td>
                <Td>{t.active ? "Active" : <span className="text-text-muted">Retired</span>}</Td>
                <Td align="right">
                  <ToggleActive table="technicians" id={t.id} name={t.full_name}
                    active={t.active} onChanged={q.retry} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <AddTechnicianModal
        key={branchId ?? "all"}
        open={addOpen}
        branches={branches}
        initialBranchId={branchId ?? undefined}
        onClose={() => setAddOpen(false)}
        onDone={() => { setAddOpen(false); q.retry(); }}
      />
    </Card>
  );
}

function AddTechnicianModal({ open, branches, initialBranchId, onClose, onDone }: {
  open: boolean;
  branches: Branch[];
  initialBranchId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState(initialBranchId ?? branches[0]?.id ?? "");
  const [hiredOn, setHiredOn] = useState(new Date().toLocaleDateString("sv-SE"));
  const [specialty, setSpecialty] = useState("");
  const [skill, setSkill] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (name.trim() === "") {
      setError("Enter the technician's name.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().from("technicians").insert({
      full_name: name.trim(),
      branch_id: branchId,
      hired_on: hiredOn || null,
      specialty: specialty.trim() || null,
      skill_level: skill || null,
    });
    setBusy(false);
    if (error) {
      setError("Not saved. Try again.");
      return;
    }
    setName("");
    setSpecialty("");
    setSkill("");
    onDone();
  }

  return (
    <Modal title="Add technician" open={open} onClose={onClose}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" error={error ?? undefined}>
          <Input value={name} autoFocus invalid={!!error}
            onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Branch">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Hire date">
          <Input type="date" value={hiredOn} onChange={(e) => setHiredOn(e.target.value)} />
        </Field>
        <Field label="Type" hint="e.g. Hairdresser, Nail technician">
          <Input value={specialty} list="specialty-suggestions"
            onChange={(e) => setSpecialty(e.target.value)} />
          <datalist id="specialty-suggestions">
            {SPECIALTY_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
          </datalist>
        </Field>
        <Field label="Skill level">
          <Select value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">—</option>
            <option value="trainee">Trainee</option>
            <option value="junior">Junior</option>
            <option value="senior">Senior</option>
            <option value="master">Master</option>
          </Select>
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>
          Add technician
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

function TargetsTab({ branches }: { branches: Branch[] }) {
  return (
    <Card title="Monthly targets">
      <p className="mb-4 text-[11px] text-text-muted">
        The dashboard paces month-to-date sales against these. Pace, not forecast.
      </p>
      <div className="space-y-4">
        {branches.map((b) => (
          <TargetRow key={b.id} branch={b} />
        ))}
      </div>
    </Card>
  );
}

function TargetRow({ branch }: { branch: Branch }) {
  const [input, setInput] = useState(String(branch.monthly_target_cents / 100));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cents = parsePesos(input);
    if (cents == null || cents < 0) {
      setError("Enter the target in pesos.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient()
      .from("branches")
      .update({ monthly_target_cents: cents })
      .eq("id", branch.id);
    setBusy(false);
    if (error) {
      setError("Not saved. Try again.");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex items-end gap-4">
      <Field label={`${branch.name} monthly target (₱)`} error={error ?? undefined}>
        <Input inputMode="decimal" value={input} className="w-48" invalid={!!error}
          onChange={(e) => setInput(e.target.value)} />
      </Field>
      <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void save()}>
        Save
      </Button>
      {saved && <span className="mb-2 text-[11px] text-data-teal">Saved</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff accounts
// ---------------------------------------------------------------------------

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner", admin: "Admin", manager: "Branch manager", front_desk: "Front desk",
};

const USER_ACC: Record<string, (p: ProfileRow) => unknown> = {
  name: (p) => p.full_name,
  role: (p) => p.role,
  branch: (p) => p.branch_id,
  status: (p) => (p.active ? "Active" : "Deactivated"),
};

function UsersTab({ branches }: { branches: Branch[] }) {
  const { profile } = useSession();
  const q = useQuery(async () => {
    const res = await createClient().from("profiles").select("*").order("full_name");
    return unwrap(res) as ProfileRow[];
  }, []);
  const { rows, th } = useSort(q.status === "ready" ? q.data : null, USER_ACC);

  return (
    <Card title="Staff accounts">
      <p className="mb-4 text-[11px] text-text-muted">
        Create the login in the Supabase dashboard (Authentication → Users → Add user), then set
        the role and branch here — new accounts start as front desk. Deactivating an account locks
        it out immediately; front desk and managers act only within their branch.
      </p>
      {q.status === "loading" && <SkeletonRows rows={4} cols={4} />}
      {q.status === "error" && <ErrorState message="Accounts did not load." onRetry={q.retry} />}
      {rows != null && (
        <Table>
          <thead>
            <tr>
              <Th {...th("name")}>Name</Th>
              <Th {...th("role")}>Role</Th>
              <Th {...th("branch")}>Branch</Th>
              <Th {...th("status")}>Status</Th>
              <Th align="right">Status toggle</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              // Your own row is read-only: demoting or deactivating yourself
              // locks you out of this page with no way back from the app.
              const self = p.id === profile.id;
              return (
                <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                  <Td className="font-bold">
                    <Truncate text={p.full_name} />
                    {self && <span className="ml-2 text-[11px] text-text-muted">(you)</span>}
                  </Td>
                  <Td>
                    {self ? (
                      ROLE_LABEL[p.role] ?? p.role
                    ) : (
                      <RoleSelect profile={p} branches={branches} onChanged={q.retry} />
                    )}
                  </Td>
                  <Td>
                    {p.role === "owner" || p.role === "admin" ? (
                      "All branches"
                    ) : (
                      <BranchSelect profile={p} branches={branches} onChanged={q.retry} />
                    )}
                  </Td>
                  <Td>{p.active ? "Active" : <span className="text-text-muted">Deactivated</span>}</Td>
                  <Td align="right">
                    {!self && <ProfileToggle profile={p} onChanged={q.retry} />}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function RoleSelect({ profile, branches, onChanged }: {
  profile: ProfileRow;
  branches: Branch[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Select
      value={profile.role}
      disabled={busy}
      className="w-36"
      onChange={async (e) => {
        setBusy(true);
        const role = e.target.value;
        await createClient()
          .from("profiles")
          .update({
            role,
            // Owner and admin roam all branches; manager and front desk
            // must have a home branch (schema constraint).
            branch_id: role === "owner" || role === "admin"
              ? null
              : profile.branch_id ?? branches[0]?.id,
          })
          .eq("id", profile.id);
        setBusy(false);
        onChanged();
      }}
    >
      <option value="owner">Owner</option>
      <option value="admin">Admin</option>
      <option value="manager">Branch manager</option>
      <option value="front_desk">Front desk</option>
    </Select>
  );
}

function BranchSelect({ profile, branches, onChanged }: {
  profile: ProfileRow;
  branches: Branch[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Select
      value={profile.branch_id ?? ""}
      disabled={busy}
      className="w-36"
      aria-label={`Branch for ${profile.full_name}`}
      onChange={async (e) => {
        setBusy(true);
        await createClient()
          .from("profiles")
          .update({ branch_id: e.target.value })
          .eq("id", profile.id);
        setBusy(false);
        onChanged();
      }}
    >
      {profile.branch_id == null && <option value="">—</option>}
      {branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </Select>
  );
}

function ProfileToggle({ profile, onChanged }: { profile: ProfileRow; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    await createClient().from("profiles").update({ active: !profile.active }).eq("id", profile.id);
    setBusy(false);
    setConfirming(false);
    onChanged();
  }

  return (
    <>
      <button
        className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-body hover:underline"
        title={profile.active ? `Deactivate ${profile.full_name}` : `Restore ${profile.full_name}`}
        aria-label={profile.active ? `Deactivate ${profile.full_name}` : `Restore ${profile.full_name}`}
        onClick={() => setConfirming(true)}
      >
        {profile.active ? <UserX size={14} /> : <UserCheck size={14} />}
        {profile.active ? "Deactivate" : "Restore"}
      </button>
      <Modal
        title={profile.active
          ? `Deactivate ${profile.full_name}?`
          : `Restore ${profile.full_name}?`}
        open={confirming}
        onClose={() => setConfirming(false)}
      >
        <p className="mb-4 text-[13px] text-text-muted">
          {profile.active
            ? "A deactivated account is locked out immediately. Its history stays."
            : "Restoring lets this account sign in again with its old role and branch."}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void apply()}>
            {profile.active ? "Deactivate" : "Restore"}
          </Button>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Businesses — branding and onboarding. The brand colour touches only the
// wordmark and brand badges; errors stay red for every business.
// ---------------------------------------------------------------------------

interface BusinessRow {
  id: string;
  name: string;
  code: string;
  sort_order: number;
  active: boolean;
  brand_color: string;
  wordmark: string | null;
  wordmark_accent: string | null;
  tagline: string | null;
  logo_path: string | null;
}

interface BranchRow2 {
  id: string;
  business_id: string;
  name: string;
  code: string;
  accent: string;
  active: boolean;
}

function BusinessesTab() {
  const q = useQuery(async () => {
    const supabase = createClient();
    const [businesses, branches] = await Promise.all([
      supabase.from("businesses").select("*").order("sort_order"),
      supabase.from("branches").select("id, business_id, name, code, accent, active").order("code"),
    ]);
    return {
      businesses: unwrap(businesses) as BusinessRow[],
      branches: unwrap(branches) as BranchRow2[],
    };
  }, []);

  if (q.status === "loading") return <Card><SkeletonRows rows={4} cols={4} /></Card>;
  if (q.status === "error") return <ErrorState message="Businesses did not load." onRetry={q.retry} />;

  return (
    <div className="space-y-6">
      <p className="text-[11px] text-text-muted">
        Branding swaps the wordmark and its accent colour when switching businesses. Buttons,
        status colours and alerts stay the same everywhere — red always means something is wrong,
        never a brand. After changing branding, reload to see it in the sidebar.
      </p>
      {q.data.businesses.map((b) => (
        <BusinessCard
          key={b.id}
          business={b}
          branches={q.data.branches.filter((br) => br.business_id === b.id)}
          onChanged={q.retry}
        />
      ))}
      <AddBusinessCard onChanged={q.retry} />
    </div>
  );
}

function BusinessCard({ business, branches, onChanged }: {
  business: BusinessRow;
  branches: BranchRow2[];
  onChanged: () => void;
}) {
  const [name, setName] = useState(business.name);
  const [wordmark, setWordmark] = useState(business.wordmark ?? "");
  const [accent, setAccent] = useState(business.wordmark_accent ?? "");
  const [tagline, setTagline] = useState(business.tagline ?? "");
  const [color, setColor] = useState(business.brand_color);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewWordmark = wordmark || name;
  const at = accent ? previewWordmark.indexOf(accent) : -1;

  async function save() {
    if (name.trim() === "") {
      setError("The business needs a name.");
      return;
    }
    if (accent && !previewWordmark.includes(accent)) {
      setError("The accented part must appear inside the wordmark.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient()
      .from("businesses")
      .update({
        name: name.trim(),
        wordmark: wordmark.trim() || null,
        wordmark_accent: accent.trim() || null,
        tagline: tagline.trim() || null,
        brand_color: color,
      })
      .eq("id", business.id);
    setBusy(false);
    if (error) {
      setError("Branding was not saved. Check the colour is a full hex value.");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onChanged();
  }

  return (
    <Card title={business.name}>
      <div className="mb-4 rounded-[4px] border border-border bg-surface-page p-4">
        <span className="flex items-baseline gap-2">
          <span className="text-[15px] font-bold tracking-tight">
            {at === -1 ? previewWordmark : (
              <>
                {previewWordmark.slice(0, at)}
                <span style={{ color }}>{accent}</span>
                {previewWordmark.slice(at + accent.length)}
              </>
            )}
          </span>
          {tagline && <span className="text-[11px] text-text-muted">{tagline}</span>}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Name" error={error ?? undefined}>
          <Input value={name} invalid={!!error} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Wordmark" hint="Shown in the sidebar; defaults to the name">
          <Input value={wordmark} onChange={(e) => setWordmark(e.target.value)} />
        </Field>
        <Field label="Accented part" hint="The substring drawn in the brand colour">
          <Input value={accent} onChange={(e) => setAccent(e.target.value)} />
        </Field>
        <Field label="Tagline">
          <Input value={tagline} onChange={(e) => setTagline(e.target.value)} />
        </Field>
        <Field label="Brand colour">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded-[4px] border border-border bg-surface-card"
              aria-label="Brand colour"
            />
            <Input value={color} onChange={(e) => setColor(e.target.value)} className="w-28 tnum" />
          </div>
        </Field>
        <div className="flex items-end gap-2 pb-px">
          <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void save()}>
            Save branding
          </Button>
          {saved && <span className="mb-2 text-[11px] text-data-teal">Saved</span>}
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <p className="mb-2 text-[11px] text-text-muted">Branches</p>
        <div className="flex flex-wrap items-center gap-2">
          {branches.map((br) => (
            <span key={br.id} className="rounded-[4px] border border-border px-2 py-1 text-[11px]">
              {br.name} · {br.code}
            </span>
          ))}
          <AddBranchInline businessId={business.id} onChanged={onChanged} />
        </div>
      </div>
    </Card>
  );
}

function AddBranchInline({ businessId, onChanged }: { businessId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [accent, setAccent] = useState<"slate" | "plum">("slate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (name.trim() === "" || code.trim() === "") {
      setError("A branch needs a name and a short code.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().from("branches").insert({
      business_id: businessId,
      name: name.trim(),
      code: code.trim().toUpperCase(),
      accent,
    });
    setBusy(false);
    if (error) {
      setError(/unique/i.test(error.message)
        ? "That branch code is already taken."
        : "The branch was not added. Try again.");
      return;
    }
    setName(""); setCode(""); setOpen(false);
    onChanged();
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>Add branch</Button>;
  }
  return (
    <span className="flex flex-wrap items-end gap-2">
      <Field label="Branch name" error={error ?? undefined}>
        <Input value={name} className="w-36" invalid={!!error}
          onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Code">
        <Input value={code} className="w-28"
          onChange={(e) => setCode(e.target.value)} placeholder="e.g. SPA-MAIN" />
      </Field>
      <Field label="Accent">
        <Select value={accent} className="w-28"
          onChange={(e) => setAccent(e.target.value as "slate" | "plum")}>
          <option value="slate">Slate</option>
          <option value="plum">Plum</option>
        </Select>
      </Field>
      <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>Add</Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  );
}

function AddBusinessCard({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (name.trim() === "" || code.trim() === "") {
      setError("A business needs a name and a short code.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().from("businesses").insert({
      name: name.trim(),
      code: code.trim().toUpperCase(),
      sort_order: 99,
    });
    setBusy(false);
    if (error) {
      setError(/unique/i.test(error.message)
        ? "That business code is already taken."
        : "The business was not added. Try again.");
      return;
    }
    setName(""); setCode("");
    onChanged();
  }

  return (
    <Card title="Add business">
      <p className="mb-4 text-[11px] text-text-muted">
        Onboarding order: add the business, add its branches here, then its service types and
        services under Services and prices, then its technicians. Clients are shared across all
        businesses automatically.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Name" error={error ?? undefined}>
          <Input value={name} className="w-64" invalid={!!error}
            onChange={(e) => setName(e.target.value)} placeholder="e.g. inStyle Barbershop" />
        </Field>
        <Field label="Code">
          <Input value={code} className="w-36"
            onChange={(e) => setCode(e.target.value)} placeholder="e.g. BARBER" />
        </Field>
        <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>
          Add business
        </Button>
      </div>
    </Card>
  );
}
