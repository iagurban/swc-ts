import {isTruthy} from "@grbn/kit";
// import {isNodeSignal} from "@grbn/kit/node";
import {fn} from "./submodule";

const a = [0, 1, 2];

console.log(a.filter(isTruthy),
    // isNodeSignal()
);
fn();
