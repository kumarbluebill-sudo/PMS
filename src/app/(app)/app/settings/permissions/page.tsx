import { Card, PageHeader } from "@/app/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "@/server/auth/permissions";
import { roleHasPermission } from "@/server/auth/permissions";
import { getCtx } from "@/server/session";

const TENANT_ROLES = ROLES.filter((r) => r !== "PLATFORM_SUPER_ADMIN" && r !== "SAAS_SUPPORT_ADMIN");

export default async function PermissionsMatrix() {
  const ctx = await getCtx();
  if (!roleHasPermission(ctx.role, "settings.view", ctx.extra)) return <p className="text-sm">You do not have access to these settings.</p>;
  return (
    <>
      <Breadcrumbs items={[{ label: "Settings", href: "/app/settings" }, { label: "Roles and permissions" }]} />
      <PageHeader title="Roles and permissions" subtitle="What each role can do. Access is enforced on the server for every action; changing a person's role is done under Users." />
      <Card>
        <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Permissions by role table">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Permissions by role</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 bg-white p-1">Permission</th>
                {TENANT_ROLES.map((r) => <th key={r} scope="col" className="min-w-20 p-1 align-bottom text-[10px] font-medium">{r.replaceAll("_", " ").toLowerCase()}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y">
              {PERMISSIONS.map((p) => (
                <tr key={p}>
                  <th scope="row" className="sticky left-0 bg-white p-1 font-mono font-normal">{p}</th>
                  {TENANT_ROLES.map((r) => {
                    const yes = ROLE_PERMISSIONS[r].includes(p);
                    return <td key={r} className="p-1 text-center">{yes ? <><span aria-hidden>✓</span><span className="sr-only">Allowed</span></> : <><span aria-hidden className="text-slate-300">–</span><span className="sr-only">Not allowed</span></>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
