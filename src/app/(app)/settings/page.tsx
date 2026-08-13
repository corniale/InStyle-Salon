"use client";

// Owner settings (spec §3): price lists, sharing rates, monthly targets,
// technicians, staff accounts. RLS enforces owner-only writes; the UI just
// reflects it. Price changes insert a new effective_from row — history is
// never rewritten (edge case 17).

import { useMemo, useState } from "react";
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
  const [tab, setTab] = useState<"services" | "technicians" | "targets" | "users" | "businesses">("services");

  return (
    <div className="space-y-6">
      <h1 className="text-[20px] font-bold">Settings</h1>

      <div className="flex rounded-[4px] border border-border w-fit">
        {([
          ["services", "Services and prices"],
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
  status: (r) => (r.s.active ? "Active" : "Retired"),
};

function ServicesTab({ branches }: { branches: Branch[] }) {
  const { businessId } = useSession();
  const [editing, setEditing] = useState<{ service: Service; branch: Branch; current: number | null } | null>(null);
  const [rateEditing, setRateEditing] = useState<Service | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "retired">("");

  const q = useQuery(async () => {
    const supabase = createClient();
    const today = new Date().toLocaleDateString("sv-SE");
    const [typesRes, servicesRes, prices] = await Promise.all([
      supabase.from("service_types").select("*").order("sort_order"),
      supabase.from("services").select("*").order("name"),
      supabase
        .from("branch_service_prices")
        .select("branch_id, service_id, price_cents, effective_from")
        .lte("effective_from", today)
        .order("effective_from", { ascending: false }),
    ]);
    const priceMap = new Map<string, PriceRow>();
    for (const p of unwrap(prices) as PriceRow[]) {
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
        Changing a price adds a new row effective today — past tickets keep the price they were
        sold at. The sharing rate shown is the company&apos;s side.
      </p>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="flex flex-wrap gap-4">
          <AddServiceInline types={data?.types ?? []} onChanged={q.retry} />
          <AddServiceTypeInline businessId={businessId} onChanged={q.retry} />
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
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="retired">Retired</option>
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
              {branches.map((b) => (
                <Th key={b.id} align="right" {...th(`price:${b.id}`)}>{b.name} price</Th>
              ))}
              <Th {...th("status")}>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, typeName }) => (
              <tr key={s.id} className={s.active ? "" : "opacity-50"}>
                <Td><Truncate text={s.name} /></Td>
                <Td className="text-text-muted">{typeName}</Td>
                <Td align="right" className="tnum">
                  <button className="hover:underline" onClick={() => setRateEditing(s)}>
                    {(Number(s.default_sharing_rate) * 100).toFixed(0)}%
                  </button>
                </Td>
                {branches.map((b) => {
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
      <RateModal
        service={rateEditing}
        onClose={() => setRateEditing(null)}
        onDone={() => { setRateEditing(null); q.retry(); }}
      />
    </Card>
  );
}

function AddServiceInline({ types, onChanged }: { types: ServiceType[]; onChanged: () => void }) {
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

  if (!open) return <Button onClick={() => setOpen(true)}>Add service</Button>;
  return (
    <span className="flex flex-wrap items-end gap-2">
      <Field label="Service name" error={error ?? undefined}>
        <Input value={name} className="w-48" invalid={!!error}
          onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type">
        <Select value={typeId} className="w-36" onChange={(e) => setTypeId(e.target.value)}>
          <option value="">—</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
      <Field label="Company share (%)">
        <Input inputMode="numeric" value={ratePct} className="w-24"
          onChange={(e) => setRatePct(e.target.value)} />
      </Field>
      <Field label="Duration (min)">
        <Input inputMode="numeric" value={duration} className="w-24"
          onChange={(e) => setDuration(e.target.value)} />
      </Field>
      <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>Add</Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
      <span className="mb-2 w-full text-[11px] text-text-muted">
        New services start with no price — set each branch&apos;s price in the table above, or they
        show as &ldquo;not offered&rdquo;.
      </span>
    </span>
  );
}

function AddServiceTypeInline({ businessId, onChanged }: {
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

  if (!open) return <Button onClick={() => setOpen(true)}>Add service type</Button>;
  return (
    <span className="flex items-end gap-2">
      <Field label="Type name" error={error ?? undefined}>
        <Input value={name} className="w-40" invalid={!!error}
          onChange={(e) => setName(e.target.value)} placeholder="e.g. Massage" />
      </Field>
      <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>Add</Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
    </span>
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

function RateModal({ service, onClose, onDone }: {
  service: Service | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!service) return;
    const pct = Number(input);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError("Enter the company share as a percentage, 0 to 100.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient()
      .from("services")
      .update({ default_sharing_rate: (pct / 100).toFixed(3) })
      .eq("id", service.id);
    setBusy(false);
    if (error) {
      setError("The rate was not saved. Try again.");
      return;
    }
    setInput("");
    onDone();
  }

  return (
    <Modal title={service ? `Sharing rate — ${service.name}` : ""} open={service != null} onClose={onClose}>
      <p className="mb-4 text-[13px] text-text-muted">
        Current company share: {service ? (Number(service.default_sharing_rate) * 100).toFixed(0) : ""}%.
        Applies to new tickets only; past lines keep the rate they were sold at. The change is audited.
      </p>
      <Field label="Company share (%)" error={error ?? undefined}>
        <Input inputMode="numeric" value={input} autoFocus invalid={!!error}
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
        className="text-[11px] hover:underline"
        onClick={() => setConfirming(true)}
      >
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
// Technicians
// ---------------------------------------------------------------------------

interface RosterRow { t: Technician; branchName: string }

const ROSTER_ACC: Record<string, (r: RosterRow) => unknown> = {
  name: (r) => r.t.full_name,
  branch: (r) => r.branchName,
  hired: (r) => r.t.hired_on,
  status: (r) => (r.t.active ? "Active" : "Retired"),
};

function TechniciansTab({ branches }: { branches: Branch[] }) {
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery(async () => {
    const res = await createClient().from("technicians").select("*").order("full_name");
    return unwrap(res) as Technician[];
  }, []);

  const rosterRows = useMemo(() => {
    if (q.status !== "ready") return null;
    return q.data.map((t): RosterRow => ({
      t,
      branchName: branches.find((b) => b.id === t.branch_id)?.name ?? "—",
    }));
  }, [q.status, q.data, branches]);
  const { rows, th } = useSort(rosterRows, ROSTER_ACC);

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
      hired_on: new Date().toLocaleDateString("sv-SE"),
    });
    setBusy(false);
    if (error) {
      setError("Not saved. Try again.");
      return;
    }
    setName("");
    q.retry();
  }

  return (
    <Card title="Technicians">
      <p className="mb-4 text-[11px] text-text-muted">
        Retiring a technician removes them from new-ticket pickers; their history stays
        (edge case: staff who leave mid-month).
      </p>
      <div className="mb-4 flex items-end gap-4">
        <Field label="Name" error={error ?? undefined}>
          <Input value={name} className="w-64" invalid={!!error}
            onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Branch">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-40">
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void add()}>
          Add technician
        </Button>
      </div>

      {q.status === "loading" && <SkeletonRows rows={6} cols={3} />}
      {q.status === "error" && <ErrorState message="Technicians did not load." onRetry={q.retry} />}
      {rows != null && (
        <Table>
          <thead>
            <tr>
              <Th {...th("name")}>Name</Th>
              <Th {...th("branch")}>Branch</Th>
              <Th {...th("hired")}>Hired</Th>
              <Th {...th("status")}>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, branchName }) => (
              <tr key={t.id} className={t.active ? "" : "opacity-50"}>
                <Td className="font-bold"><Truncate text={t.full_name} /></Td>
                <Td>{branchName}</Td>
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
    </Card>
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

const USER_ACC: Record<string, (p: ProfileRow) => unknown> = {
  name: (p) => p.full_name,
  role: (p) => p.role,
  branch: (p) => p.branch_id,
  status: (p) => (p.active ? "Active" : "Deactivated"),
};

function UsersTab({ branches }: { branches: Branch[] }) {
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
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                <Td className="font-bold"><Truncate text={p.full_name} /></Td>
                <Td>
                  <RoleSelect profile={p} branches={branches} onChanged={q.retry} />
                </Td>
                <Td>
                  {p.role === "owner" ? (
                    "All branches"
                  ) : (
                    <BranchSelect profile={p} branches={branches} onChanged={q.retry} />
                  )}
                </Td>
                <Td>{p.active ? "Active" : <span className="text-text-muted">Deactivated</span>}</Td>
                <Td align="right">
                  <ProfileToggle profile={p} onChanged={q.retry} />
                </Td>
              </tr>
            ))}
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
            // A non-owner must have a branch (schema constraint).
            branch_id: role === "owner" ? profile.branch_id : profile.branch_id ?? branches[0]?.id,
          })
          .eq("id", profile.id);
        setBusy(false);
        onChanged();
      }}
    >
      <option value="owner">Owner</option>
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
        className="text-[11px] hover:underline"
        onClick={() => setConfirming(true)}
      >
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
