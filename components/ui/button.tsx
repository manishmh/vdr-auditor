import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors duration-150 ease-app focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-teal-800 text-white hover:bg-teal-900",
        secondary: "border border-stone-300 bg-white text-stone-800 hover:bg-stone-100",
        danger: "border border-red-300 bg-white text-red-800 hover:bg-red-50",
        ghost: "text-stone-600 hover:bg-stone-100 hover:text-stone-900",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
