function check(user) {
  var A = 3, B = 4;
  while (A + B !== 0) {
    switch (A + B) {
      case 7:
        console.log("start");
        if (user.admin) { A += 2; } else { A += 5; }
        break;
      case 9:
        console.log("admin:", user.name);
        A = 0; B = 0;
        break;
      case 12:
        console.log("guest");
        return "g" + (A * 10 + B);
    }
  }
  return "a";
}
console.log(check({ admin: true, name: "ada" }), check({ admin: false }));
// LEVEL: 3
// EXPECT: if (user.admin) {
// EXPECT: console.log("admin:", user.name);
// EXPECT: return "g84";
// GONE: switch
