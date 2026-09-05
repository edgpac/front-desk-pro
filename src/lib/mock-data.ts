import leakPhoto from "@/assets/leak-detail.jpg";
import panelPhoto from "@/assets/electrician-panel.jpg";
import sinkPhoto from "@/assets/plumber-under-sink.jpg";

export type LeadStatus = "new" | "quoted" | "booked" | "won" | "lost";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  quoted: "Quoted",
  booked: "Booked",
  won: "Won",
  lost: "Lost",
};

export type LineItem = {
  id: string;
  description: string;
  qty: number;
  unit: string;
  rate: number;
};

export type Lead = {
  id: string;
  customer: string;
  phone: string;
  address: string;
  requested: string;
  channel: "Widget" | "Quote link" | "Shared link" | "WhatsApp";
  status: LeadStatus;
  photo: string;
  problem: string;
  diagnosis: string;
  confidence: "High" | "Medium" | "Low";
  lineItems: LineItem[];
  followUps: { role: "customer" | "assistant"; text: string }[];
};

export const lineItemsTotal = (items: LineItem[]) =>
  items.reduce((sum, i) => sum + i.qty * i.rate, 0);

export const money = (n: number, currency: string = "USD") =>
  n.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 0 });

export const LEADS: Lead[] = [
  {
    id: "L-2845",
    customer: "Marisol Vega",
    phone: "(512) 555-0264",
    address: "812 Nogales Ave, Austin TX",
    requested: "Today, 8:10 AM",
    channel: "WhatsApp",
    status: "new",
    photo: sinkPhoto,
    problem: "El fregadero de la cocina gotea debajo y la llave no cierra bien.",
    diagnosis:
      "La llave necesita un cartucho nuevo — el goteo constante ya desgastó el sello interno. También hay una fuga menor en la conexión de abajo del fregadero que se puede sellar en la misma visita.",
    confidence: "High",
    lineItems: [
      { id: "a", description: "Cambio de cartucho de la llave", qty: 1, unit: "trabajo", rate: 95 },
      { id: "b", description: "Reparación de fuga en conexión", qty: 1, unit: "trabajo", rate: 60 },
    ],
    followUps: [
      {
        role: "customer",
        text: "¿Cuánto costaría reparar el fregadero? Necesito que alguien venga esta semana.",
      },
      {
        role: "assistant",
        text: "Según la foto, es un cambio de cartucho y sellar una fuga menor — normalmente $155 en total, con la visita incluida. ¿Le funciona el jueves por la mañana?",
      },
      { role: "customer", text: "Sí, el jueves está bien. Gracias!" },
    ],
  },
  {
    id: "L-2841",
    customer: "Dana Whitfield",
    phone: "(512) 555-0182",
    address: "418 Pecan St, Austin TX",
    requested: "Today, 7:42 AM",
    channel: "Widget",
    status: "new",
    photo: leakPhoto,
    problem: "Water heater is dripping from the bottom fitting and there's rust on the floor.",
    diagnosis:
      "Corroded drain valve on a 40-gal gas heater, roughly 11 years old by the label. Tank itself is not weeping — the leak is at the threaded fitting. Replace the valve and flush the tank; recommend quoting a full replacement as an option given the age.",
    confidence: "High",
    lineItems: [
      { id: "a", description: "Drain valve replacement (brass, 3/4in)", qty: 1, unit: "job", rate: 165 },
      { id: "b", description: "Tank flush & sediment clear", qty: 1, unit: "job", rate: 95 },
      { id: "c", description: "Labor", qty: 1.5, unit: "hr", rate: 125 },
    ],
    followUps: [
      { role: "customer", text: "Is this something that can wait until Monday?" },
      {
        role: "assistant",
        text: "It can, as long as the drip stays slow and nothing is stored on the floor nearby. If the puddle grows, shut the cold inlet valve on top of the heater and call.",
      },
    ],
  },
  {
    id: "L-2839",
    customer: "Marcus Hale",
    phone: "(512) 555-0447",
    address: "2205 Ridgeway Dr, Austin TX",
    requested: "Today, 6:15 AM",
    channel: "Quote link",
    status: "quoted",
    photo: panelPhoto,
    problem: "Breaker keeps tripping when the dryer runs. Panel looks old.",
    diagnosis:
      "Federal Pacific-era panel with a double-tapped 30A breaker feeding the dryer circuit. Tripping is a load/termination issue, not the appliance. Recommend dedicated 30A circuit; note the panel brand for a replacement conversation.",
    confidence: "Medium",
    lineItems: [
      { id: "a", description: "Dedicated 30A dryer circuit, up to 25ft run", qty: 1, unit: "job", rate: 620 },
      { id: "b", description: "Breaker + materials", qty: 1, unit: "job", rate: 140 },
    ],
    followUps: [],
  },
  {
    id: "L-2836",
    customer: "Priya Raman",
    phone: "(512) 555-0913",
    address: "77 Oak Hollow, Round Rock TX",
    requested: "Yesterday, 4:02 PM",
    channel: "Widget",
    status: "booked",
    photo: sinkPhoto,
    problem: "Kitchen sink backs up and the trap under the cabinet drips.",
    diagnosis: "Failed slip-joint washer at the P-trap plus partial line blockage past the tee.",
    confidence: "High",
    lineItems: [
      { id: "a", description: "P-trap rebuild", qty: 1, unit: "job", rate: 145 },
      { id: "b", description: "Drain clearing, kitchen line", qty: 1, unit: "job", rate: 210 },
    ],
    followUps: [],
  },
  {
    id: "L-2830",
    customer: "Ellis Contracting",
    phone: "(512) 555-0620",
    address: "1400 Braker Ln, Austin TX",
    requested: "Wed, 11:20 AM",
    channel: "Shared link",
    status: "won",
    photo: panelPhoto,
    problem: "Need three outlets added in a garage workshop.",
    diagnosis: "Three 20A receptacles off an existing subpanel, surface conduit run.",
    confidence: "High",
    lineItems: [{ id: "a", description: "20A receptacle, surface conduit", qty: 3, unit: "ea", rate: 210 }],
    followUps: [],
  },
  {
    id: "L-2822",
    customer: "Sandra Boyle",
    phone: "(512) 555-0338",
    address: "9 Cedar Bend, Austin TX",
    requested: "Tue, 8:55 AM",
    channel: "Widget",
    status: "lost",
    photo: leakPhoto,
    problem: "Outdoor spigot won't shut off all the way.",
    diagnosis: "Worn hose bibb stem washer; straight swap.",
    confidence: "High",
    lineItems: [{ id: "a", description: "Hose bibb repair", qty: 1, unit: "job", rate: 135 }],
    followUps: [],
  },
];

export const getLead = (id: string) => LEADS.find((l) => l.id === id);

export type PriceRow = {
  id: string;
  service: string;
  category: string;
  pricing: "Flat" | "Hourly" | "Range";
  price: string;
};

export const PRICE_SHEET: PriceRow[] = [
  { id: "p1", service: "Service call / diagnostic", category: "General", pricing: "Flat", price: "$89" },
  { id: "p2", service: "Standard labor rate", category: "General", pricing: "Hourly", price: "$125/hr" },
  { id: "p3", service: "After-hours labor rate", category: "General", pricing: "Hourly", price: "$185/hr" },
  { id: "p4", service: "Drain clearing — kitchen line", category: "Drains", pricing: "Flat", price: "$210" },
  { id: "p5", service: "Drain clearing — main line", category: "Drains", pricing: "Range", price: "$325–$650" },
  { id: "p6", service: "P-trap rebuild", category: "Drains", pricing: "Flat", price: "$145" },
  { id: "p7", service: "Water heater — drain valve", category: "Water heaters", pricing: "Flat", price: "$165" },
  { id: "p8", service: "Water heater — 40gal replacement", category: "Water heaters", pricing: "Range", price: "$1,650–$2,200" },
  { id: "p9", service: "Toilet reset with new wax ring", category: "Fixtures", pricing: "Flat", price: "$195" },
  { id: "p10", service: "Hose bibb repair", category: "Fixtures", pricing: "Flat", price: "$135" },
];

export const FUNNEL = [
  { stage: "Requests", count: 148 },
  { stage: "Quoted", count: 121 },
  { stage: "Booked", count: 74 },
  { stage: "Won", count: 61 },
];

export const WEEKDAYS = [
  { day: "Mon", leads: 26 },
  { day: "Tue", leads: 31 },
  { day: "Wed", leads: 22 },
  { day: "Thu", leads: 28 },
  { day: "Fri", leads: 24 },
  { day: "Sat", leads: 12 },
  { day: "Sun", leads: 5 },
];

export const INVOICES = [
  { id: "INV-1042", date: "Aug 1, 2026", amount: "$39.00", plan: "Crew — monthly" },
  { id: "INV-1019", date: "Jul 1, 2026", amount: "$39.00", plan: "Crew — monthly" },
  { id: "INV-0994", date: "Jun 1, 2026", amount: "$19.00", plan: "Solo — monthly" },
  { id: "INV-0971", date: "May 1, 2026", amount: "$19.00", plan: "Solo — monthly" },
];

export type Tenant = {
  name: string;
  slug: string;
  phone: string;
  email: string;
  address: string;
  area: string;
  hours: string;
  trade: string;
  brandColor: string;
  currency: "USD" | "MXN" | "CAD";
  calendarLink: string;
  paymentTerms: string;
  warrantyTerms: string;
  taxRate: number;
};

export const TENANT: Tenant = {
  name: "Hale & Sons Plumbing",
  slug: "hale-and-sons",
  phone: "(512) 555-0110",
  email: "office@haleandsonsplumbing.com",
  address: "4110 Guadalupe St, Austin, TX 78751",
  area: "Austin + Round Rock, 25 mi",
  hours: "Mon–Sat 7AM–6PM",
  trade: "Plumbing",
  brandColor: "#B4531F",
  currency: "USD",
  calendarLink: "https://cal.com/hale-and-sons/service-call",
  paymentTerms: "50% deposit at start, 50% due on completion.",
  warrantyTerms: "30-day warranty on all workmanship.",
  taxRate: 8.25,
};

export const embedSnippet = (slug: string) =>
  `<!-- FrontDesk quote widget -->
<script src="https://cdn.frontdesk.tools/widget.js"
        data-shop="${slug}"
        data-position="bottom-right"
        async></script>`;

export const quoteLink = (slug: string) => `https://frontdesk.tools/quote/${slug}`;
