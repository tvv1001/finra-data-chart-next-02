const { unwrapDetailPayload } = require('./unwrap.js');
const payload = {
  crd: "4873777",
  found: true,
  finraNode: {
    bccontent: { basicInformation: { firstName: "A" }, currentEmployments: [{ firmId: 1 }] },
    iacontent: { basicInformation: { firstName: "B" }, currentEmployments: [{ firmId: 2 }] }
  }
};
console.log(JSON.stringify(unwrapDetailPayload(payload), null, 2));
