import type { Nvim } from "@/nvim/context";
import { Board } from "./Board";
import { Plan, PlanDiff } from "./Plan";
import { Usage } from "./Usage";
import { ImageView, MarkdownView, PdfView } from "./Viewers";

export type ViewProps<S = any> = { state: S; win: number; focused: boolean; nvim: Nvim };

export const VIEWS: Record<string, React.ComponentType<ViewProps>> = {
  board: Board,
  usage: Usage,
  plan: Plan,
  "plan-diff": PlanDiff,
  image: ImageView,
  pdf: PdfView,
  markdown: MarkdownView,
};
