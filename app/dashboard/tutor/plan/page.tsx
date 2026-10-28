import { redirect } from "next/navigation";
import { PLANNER_PATH } from "@/lib/app/plan-views";

/** The revision plan moved from Jami's page to Plan; old links still land on it. */
export default function TutorPlanRedirect() {
  redirect(PLANNER_PATH);
}
