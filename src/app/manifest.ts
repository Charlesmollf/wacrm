import type { MetadataRoute } from "next";

/**
 * Manifiesto PWA.
 *
 * Sirve para una sola cosa concreta: que al agregar el CRM a la
 * pantalla de inicio del iPhone se abra SIN el marco del navegador
 * (los botones grises de las esquinas y la barra de abajo son de
 * Safari, no de la app; `display: standalone` es lo unico que los
 * quita).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MonsterCRM",
    short_name: "MonsterCRM",
    description: "CRM de WhatsApp de Kaffeejager Roastery",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#25D366",
    lang: "es",
    icons: [
      { src: "/icon", sizes: "32x32", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
