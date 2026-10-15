import { redirect } from "next/navigation";

/** The channel manager now lives at /app/channels. */
export default function ChannelSettings() {
  redirect("/app/channels");
}
