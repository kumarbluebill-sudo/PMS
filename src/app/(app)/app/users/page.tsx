import { inviteAction, resetMfaAction, updateMemberAction } from "@/app/account-actions";
import { btn, btnGhost, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { withTenant } from "@/server/db/withTenant";
import { getCtx } from "@/server/session";
import { PERMISSIONS, roleHasPermission, ROLES } from "@/server/auth/permissions";
import { listMembers } from "@/server/services/users";

const ASSIGNABLE = ROLES.filter((r) => !r.startsWith("PLATFORM") && r !== "SAAS_SUPPORT_ADMIN");

export default async function Users({ searchParams }: PageProps<"/app/users">) {
  const { error, ok } = await searchParams;
  const ctx = await getCtx();
  const db = getDb();
  const [members, props] = await Promise.all([
    listMembers(db, ctx),
    withTenant(db, ctx.tenantId, (tx) => tx.property.findMany({ where: { id: { in: ctx.accessiblePropertyIds } }, select: { id: true, name: true } })),
  ]);
  const canGrant = roleHasPermission(ctx.role, "roles.manage", ctx.extra);
  const roles = ASSIGNABLE.filter((r) => ctx.role === "HOTEL_OWNER" || (r !== "HOTEL_OWNER" && r !== "GROUP_ADMIN"));
  return (
    <>
      <PageHeader title="Users & access" subtitle="Roles set the baseline; extra permissions add individual grants." />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      {typeof ok === "string" && <p role="status" className="mb-3 text-sm text-green-800">{ok}</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Invite a team member">
          <form action={inviteAction} className="space-y-3">
            <Field label="Email"><input name="email" type="email" required className={input} /></Field>
            <Field label="Role">
              <select name="role" className={input}>
                {roles.map((r) => <option key={r} value={r}>{r.replaceAll("_", " ").toLowerCase()}</option>)}
              </select>
            </Field>
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium text-slate-700">Properties</legend>
              {props.map((p) => (
                <label key={p.id} className="flex items-center gap-2"><input type="checkbox" name="propertyIds" value={p.id} defaultChecked /> {p.name}</label>
              ))}
            </fieldset>
            <button className={btn}>Send invitation</button>
          </form>
        </Card>
        <div className="space-y-3 lg:col-span-2">
          {members.map((m) => (
            <Card key={m.id}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{m.user.name} {!m.active && <span className="text-xs text-red-700">(deactivated)</span>}</div>
                  <div className="text-xs text-slate-500">{m.user.email} · MFA {m.user.mfaEnabled ? "on" : "off"}</div>
                </div>
                {m.user.mfaEnabled && m.userId !== ctx.userId && (
                  <form action={resetMfaAction}>
                    <input type="hidden" name="userId" value={m.userId} />
                    <button className={btnGhost}>Reset MFA</button>
                  </form>
                )}
              </div>
              <form action={updateMemberAction} className="space-y-2 text-sm">
                <input type="hidden" name="membershipId" value={m.id} />
                <div className="flex flex-wrap items-center gap-3">
                  <select name="role" defaultValue={m.role} className="rounded-md border border-slate-300 p-1.5" aria-label="Role">
                    {ASSIGNABLE.map((r) => <option key={r} value={r}>{r.replaceAll("_", " ").toLowerCase()}</option>)}
                  </select>
                  <label className="flex items-center gap-1"><input type="checkbox" name="active" defaultChecked={m.active} /> Active</label>
                </div>
                <div className="flex flex-wrap gap-3">
                  {props.map((p) => (
                    <label key={p.id} className="flex items-center gap-1 text-xs"><input type="checkbox" name="propertyIds" value={p.id} defaultChecked={m.properties.some((x) => x.propertyId === p.id)} /> {p.name}</label>
                  ))}
                </div>
                {canGrant && (
                  <details>
                    <summary className="cursor-pointer text-xs text-slate-600">Extra permissions</summary>
                    <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
                      {PERMISSIONS.map((p) => (
                        <label key={p} className="flex items-center gap-1"><input type="checkbox" name="extra" value={p} defaultChecked={m.extraPermissions.includes(p)} /> {p}</label>
                      ))}
                    </div>
                  </details>
                )}
                <button className={btnGhost}>Save</button>
              </form>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
