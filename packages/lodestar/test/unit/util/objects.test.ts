import {expect} from "chai";
import {uint64} from "@chainsafe/eth2.0-types";
import {config} from "@chainsafe/eth2.0-config/lib/presets/mainnet";
import {mostFrequent} from "../../../src/util/objects";
import {describe, it} from "mocha";

describe("Objects helper", () => {

  it("return most frequent objects", () => {
    const obj1 = 1n;
    const obj2 = 2n;
    const obj3 = 3n;
    const array = [];
    array.push(obj1);
    array.push(obj1);
    array.push(obj3);
    array.push(obj2);
    array.push(obj3);
    array.push(obj1);
    array.push(obj3);
    const result = mostFrequent<uint64>(config.types.uint64, array);
    expect(result).to.be.deep.equal([obj1, obj3]);
  });

});
