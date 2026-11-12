import type { Nvim } from "@/nvim/context";
import { Avatar } from "./Avatar";
import { Board } from "./Board";
import { BrainMemory, Brains } from "./Brains";
import { Cards } from "./Cards";
import { Conversation } from "./Conversation";
import { Fleet } from "./Fleet";
import { Holds } from "./Holds";
import { Media } from "./Media";
import { Meetings } from "./Meetings";
import { Plan, PlanDiff, PlanGoals, PlanPriority } from "./Plan";
import { Projects } from "./Projects";
import { Review } from "./Review";
import { Settings } from "./Settings";
import { Usage } from "./Usage";
import { ImageView, MarkdownView, PdfView } from "./Viewers";

// buf: the view buffer the panel is over.
export type ViewProps<S = any> = { state: S; win: number; buf: number; focused: boolean; nvim: Nvim };

export const VIEWS: Record<string, React.ComponentType<ViewProps>> = {
  projects: Projects,
  board: Board,
  review: Review,
  cards: Cards,
  media: Media,
  avatar: Avatar,
  usage: Usage,
  settings: Settings,
  fleet: Fleet,
  brains: Brains,
  "brain-memory": BrainMemory,
  holds: Holds,
  meetings: Meetings,
  plan: Plan,
  "plan-diff": PlanDiff,
  "plan-goals": PlanGoals,
  "plan-priority": PlanPriority,
  image: ImageView,
  pdf: PdfView,
  markdown: MarkdownView,
  conversation: Conversation,
};
