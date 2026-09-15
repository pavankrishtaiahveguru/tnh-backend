// Bridge: re-export the existing frontend service catalog so the backend
// seeder uses the exact same data (single source of truth, no duplication).
export { services } from "../../tnh-salon/src/data/services.js";
