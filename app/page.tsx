import { redirect } from "next/navigation";

/**
 * The door opens on the roadmap, not on Transaction Review.
 *
 * /transactions is where someone lands when they already know what they are
 * looking for; it answered nothing for someone who does not know what to do
 * first, which is what the roadmap is for. It stays reachable from the sidebar
 * and from the roadmap itself.
 */
export default function Home() {
  redirect("/start");
}
