import nextConfig from "eslint-config-next";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".next/**", "out/**", "next-env.d.ts", "public/**"] },
  ...nextConfig,
  ...tseslint.configs.recommended,
);
