const BASE_URL = "http://localhost:3000";

// Paste your token here
const AUTH_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjJhMmJlMmU5LTI3MzEtNDYzNS04NDkxLTdkNmJiOWFkOWUzYyIsImlhdCI6MTc4MTkwMjU4OCwiZXhwIjoxNzg0NDk0NTg4fQ.H7Pmp32G8tdDfuo3g8NQKbLURwzU-PZU-fU7VBP3I4o";
const floors = [
 
  // {
  //   floorId: "e6cf8438-e75d-4d85-8c40-1fd9bc27af2a",
  //   rooms: ["VY 027", "VY 028", "VY 029", "VY 030"],
  // },
  {
    floorId: "4e603e6a-f76b-4195-abbe-e413503f7484",
    rooms: ["VY 112", "VY 113", "VY 123"],
  },
  {
    floorId: "9c486e1d-4e5f-47ec-8574-779574d713fd",
    rooms: ["VY 206", "VY 212", "VY 222"],
  },
  {
    floorId: "26dce00b-c45d-463a-9438-0de14e268bff",
    rooms: ["VY 314", "VY 324"],
  },
];

async function createRoom(floorId, roomName) {
  const url = `${BASE_URL}/buildings/floor/${floorId}/room`;

  const payload = {
    name: roomName,
    room_type: "lab",
    capacity: 32,
    equipment: [],
    is_active: true,
    requires_approval: true,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    if (!response.ok) {
      console.error(`❌ Failed ${roomName}`);
      console.error(text);
      return;
    }

    console.log(`✅ Created ${roomName}`);
    console.log(text);
  } catch (err) {
    console.error(`❌ Failed ${roomName}:`, err);
  }
}

async function main() {
  for (const floor of floors) {
    for (const room of floor.rooms) {
      await createRoom(floor.floorId, room);

      // Optional delay to avoid overwhelming API
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.log("🎉 All room creation requests completed.");
}

main();
