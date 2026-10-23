import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';

export default tseslint.config(
 {ignores:['.next/**','node_modules/**','next-env.d.ts','tests/**','.beta-browser/**','playwright.config.cjs']},
 js.configs.recommended,
 ...tseslint.configs.recommended,
 {plugins:{'@next/next':next}},
 {files:['**/*.ts','**/*.tsx'],plugins:{'react-hooks':hooks},rules:{
  ...next.configs.recommended.rules,...next.configs['core-web-vitals'].rules,
  'react-hooks/rules-of-hooks':'error','react-hooks/exhaustive-deps':'error',
  '@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]
 }}
);
