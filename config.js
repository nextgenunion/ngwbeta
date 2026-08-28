// App-wide configuration: organization info, contact, and social links.
// Edit the values between the quotes — nothing else in the app needs to
// change when you update these. Leave a value as "" (empty) to hide that
// item; it simply won't appear until a real value is added.

window.SONGBOOK_APP_CONFIG = {
  orgName: "Next Gen Union",
  contactEmail: "uchkabol@gmail.com",

  // Shown as icon links on the About page. Leave a value as "" to hide
  // that icon — these are placeholder/dummy URLs for now, swap them for
  // the real ones whenever they're ready.
  social: {
    facebook: "https://facebook.com/ngworship",
    youtube: "https://youtube.com/@ngworship",
    instagram: "https://instagram.com/ngworship",
    website: "https://ngworship.example.com",
  },

  // Shown on the About page under "Credits", as "Role — Name" (e.g.
  // "Project Lead — Uchkabol"). `role` here is really "what they worked
  // on / contributed" (a role title, or a specific contribution like
  // "Suggested the idea") — shown first, above the name. Add more
  // objects to the array as more people join. Leave the array empty
  // ([]) to hide the Credits section entirely.
  credits: [
    { role: "Project Lead", name: "Uchkabol" },
  ],
};
