import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "bin"],
  },
  {
    files: ["**/*.ts"],
    extends: [
      ...tseslint.configs.recommended,
    ],
  },
);
