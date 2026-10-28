import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Jami",
    short_name: "Jami",
    description: "Practice real GCSE and A-level exam questions, keep what you learn as flashcards, and know what to revise next.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    /*
     * Android's own launch screen. Kept on the default theme's
     * `--color-surface-base`, the same colour the iOS launch images hold, so
     * both platforms open on one continuous colour rather than on the purple
     * theme's background this was left at when the default palette moved to
     * navy.
     */
    background_color: "#040827",
    theme_color: "#040827",
    categories: ["education", "productivity"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
