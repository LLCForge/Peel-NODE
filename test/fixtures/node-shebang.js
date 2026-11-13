#!/usr/bin/env node
eval(Buffer.from("Y29uc29sZS5sb2coImhpIik=", "base64").toString());
// EXPECT: #!/usr/bin/env node
// EXPECT: console.log("hi");
// GONE: Buffer
