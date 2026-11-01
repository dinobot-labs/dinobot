import { createReleaseWorker } from "./worker.ts";
import sh from "./install.sh.txt";
import ps1 from "./install.ps1.txt";
import installer from "./install.mjs.txt";

export default createReleaseWorker({"/install.sh": sh, "/install.ps1": ps1, "/install.mjs": installer});
