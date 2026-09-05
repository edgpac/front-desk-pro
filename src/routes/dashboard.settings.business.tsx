import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TENANT } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/settings/business")({
  component: BusinessSettings,
});

function BusinessSettings() {
  const [form, setForm] = useState({ ...TENANT });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader eyebrow="Settings" title="Business info" />

      <Panel>
        <form
          className="grid gap-5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            toast.success("Saved");
          }}
        >
          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Business name</span>
            <Input className="mt-1.5" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Trade</span>
            <Input className="mt-1.5" value={form.trade} onChange={(e) => set("trade", e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Phone</span>
            <Input className="mt-1.5" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Service area</span>
            <Input className="mt-1.5" value={form.area} onChange={(e) => set("area", e.target.value)} />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="label-caps text-muted-foreground">Calendar link</span>
            <Input
              className="mt-1.5"
              value={form.calendarLink}
              onChange={(e) => set("calendarLink", e.target.value)}
              placeholder="https://cal.com/your-business/service-call"
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              Your existing Cal.com or Calendly link — bookings open here pre-filled with the job details.
            </span>
          </label>
          <div className="sm:col-span-2">
            <Button type="submit">Save</Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
