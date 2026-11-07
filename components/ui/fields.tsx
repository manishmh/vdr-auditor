import * as React from "react";
import { cn } from "@/lib/utils";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 cursor-pointer rounded-md border border-stone-300 bg-white px-2.5 text-sm text-stone-800",
        "transition-colors duration-150 ease-app focus:border-teal-700 focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function TextInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 rounded-md border border-stone-300 bg-white px-2.5 text-sm text-stone-800 placeholder:text-stone-500",
        "transition-colors duration-150 ease-app focus:border-teal-700 focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function TextArea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "rounded-md border border-stone-300 bg-white px-2.5 py-2 text-sm text-stone-800 placeholder:text-stone-500",
        "transition-colors duration-150 ease-app focus:border-teal-700 focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function FieldLabel({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("mb-1 block text-xs font-medium text-stone-600", className)} {...props} />
  );
}
