import * as os from "os";
import * as path from "path";

export const GRASP_HOME = path.join(os.homedir(), ".grasp");
export const GLOBAL_CONFIG_PATH = path.join(GRASP_HOME, "config.json");
export const DB_PATH = path.join(GRASP_HOME, "history.db");
export const REPO_CONFIG_FILENAME = ".grasp.json";
