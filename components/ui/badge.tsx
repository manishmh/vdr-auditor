import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        slate: "border-stone-200 bg-stone-100 text-stone-700",
        red: "border-transparent bg-red-700 text-white",
        orange: "border-transparent bg-orange-700 text-white",
        amber: "border-amber-200 bg-amber-100 text-amber-900",
        blue: "border-transparent bg-blue-800 text-white",
        teal: "border-transparent bg-teal-800 text-white",
        outline: "border-stone-300 bg-white text-stone-600",
      },
    },
    defaultVariants: { tone: "slate" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
