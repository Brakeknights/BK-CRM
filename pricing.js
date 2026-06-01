// Brake Knights service pricing table.
// parts: cost of parts only (tax is calculated on parts + shopSupplies).
// labor: cost of labor only (not taxed in Virginia).
// shopSupplies: flat shop supply fee (taxed).
// taxRate: applied to (parts + shopSupplies). Virginia rate = 7% (6% state + 1% NVTA).

module.exports = {
  taxRate: 0.07,
  services: {
    'Front Pads': {
      standard: { parts: 135, labor: 130, shopSupplies: 10 },
      premium:  { parts: 162, labor: 133, shopSupplies:  5 }
    },
    'Rear Pads': {
      standard: { parts: 135, labor: 130, shopSupplies: 10 },
      premium:  { parts: 162, labor: 163, shopSupplies:  5 }
    },
    'Front and Rear Pads': {
      standard: { parts: 270, labor: 185, shopSupplies: 10 },
      premium:  { parts: 261, labor: 214, shopSupplies:  5 }
    },
    'Front Pads and Rotors': {
      standard: { parts: 281, labor: 214, shopSupplies: 10 },
      premium:  { parts: 289, labor: 236, shopSupplies:  5 }
    },
    'Rear Pads and Rotors': {
      standard: { parts: 289, labor: 236, shopSupplies: 10 },
      premium:  { parts: 316, labor: 259, shopSupplies: 10 }
    },
    'Front and Rear Pads and Rotors': {
      standard: { parts: 470, labor: 385, shopSupplies: 10 },
      premium:  { parts: 525, labor: 430, shopSupplies:  5 }
    },
    'Front Rotors': {
      standard: { parts: 179, labor: 146, shopSupplies: 10 },
      premium:  { parts: 206, labor: 169, shopSupplies:  5 }
    },
    'Rear Rotors': {
      standard: { parts: 190, labor: 155, shopSupplies:  5 },
      premium:  { parts: 217, labor: 178, shopSupplies:  5 }
    },
    'Front and Rear Rotors': {
      standard: { parts: 316, labor: 259, shopSupplies:  5 },
      premium:  { parts: 371, labor: 304, shopSupplies:  5 }
    },
    'Drums and Shoes': {
      standard: { parts: 316, labor: 259, shopSupplies:  5 },
      premium:  { parts:   0, labor:   0, shopSupplies:  0 }
    },
    'Front Pads, Rotors, and Drums and Shoes': {
      standard: { parts: 492, labor: 403, shopSupplies:  5 },
      premium:  { parts:   0, labor:   0, shopSupplies:  0 }
    },
    'Brake Fluid Flush': {
      standard: { parts: 0, labor: 0, shopSupplies: 0 },
      premium:  { parts: 0, labor: 0, shopSupplies: 0 }
    },
    'Brake Inspection': {
      standard: { parts: 0, labor: 0, shopSupplies: 0 },
      premium:  { parts: 0, labor: 0, shopSupplies: 0 }
    },
    'Caliper Replacement': {
      standard: { parts: 0, labor: 0, shopSupplies: 0 },
      premium:  { parts: 0, labor: 0, shopSupplies: 0 }
    },
    'Brake Hose Replacement': {
      standard: { parts: 0, labor: 0, shopSupplies: 0 },
      premium:  { parts: 0, labor: 0, shopSupplies: 0 }
    },
    'Describe Issue / Not Sure': {
      standard: { parts: 0, labor: 0, shopSupplies: 0 },
      premium:  { parts: 0, labor: 0, shopSupplies: 0 }
    }
  }
};
