import { cn } from "@/lib/utils";
import { CheckCircle2, Circle, XCircle, Target } from "lucide-react";

export type ChecklistItem = {
  id: string;
  label: string;
  detail?: string;
  status: "pass" | "fail" | "pending";
};

type Props = {
  items: ChecklistItem[];
  readyToStart: boolean;
};

export function SniperChecklistPanel({ items, readyToStart }: Props) {
  const passCount = items.filter((i) => i.status === "pass").length;

  return (
    <section
      className={cn(
        "rounded-xl border p-3 md:p-5",
        readyToStart ? "border-gain/40 bg-gain/5" : "border-border bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <h2 className="text-sm md:text-base font-semibold text-foreground flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          Sniper pre-flight checklist
        </h2>
        <span
          className={cn(
            "text-[10px] md:text-xs font-medium px-2 py-0.5 rounded-full shrink-0",
            readyToStart ? "bg-gain/20 text-gain" : "bg-muted text-muted-foreground",
          )}
        >
          {passCount}/{items.length} ready
        </span>
      </div>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-xs md:text-sm">
            {item.status === "pass" ? (
              <CheckCircle2 className="w-4 h-4 text-gain shrink-0 mt-0.5" />
            ) : item.status === "fail" ? (
              <XCircle className="w-4 h-4 text-loss shrink-0 mt-0.5" />
            ) : (
              <Circle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            )}
            <div>
              <p className={cn("font-medium", item.status === "fail" && "text-loss")}>{item.label}</p>
              {item.detail && <p className="text-[10px] md:text-xs text-muted-foreground mt-0.5">{item.detail}</p>}
            </div>
          </li>
        ))}
      </ul>

      <p className="text-[10px] md:text-xs text-muted-foreground mt-3 pt-2 border-t border-border/60">
        {readyToStart
          ? "All checks passed — you can start the bot in the sniper window."
          : "Fix failed items before starting. Sitting out is valid when edge conditions are not met."}
      </p>
    </section>
  );
}
