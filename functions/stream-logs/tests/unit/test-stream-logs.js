'use strict';

const { extractGcFields } = require('../../stream-logs.js');
const chai = require('chai');
const expect = chai.expect;

describe('Stream Logs Test', function () {
    it('ignores lines without GC values', async () => {
        expect(extractGcFields("test")).to.be.false;
    });
    it('extract matched GC values', async () => {
        expect(extractGcFields("[2020-07-17T20:32:51.613+0000][gc] GC(266) Pause Full (Allocation Failure) 385M->3M(421M) 18.344ms")).to.deep.equal({
            "timestamp": "2020-07-17T20:32:51.613+0000",
            "gc_type": "Pause Full",
            "gc_cause": "Allocation Failure",
            "heap_before_gc": "385",
            "heap_after_gc": "3",
            "heap_size_gc": "421",
            "gc_duration": "18.344"
        });
    });
}); 
