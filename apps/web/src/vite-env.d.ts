/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the assistant's model endpoint lives. Unset means the rule-based
   * planner. Deliberately a URL and not a key — see src/ai/planner.ts.
   */
  readonly VITE_ASSISTANT_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
