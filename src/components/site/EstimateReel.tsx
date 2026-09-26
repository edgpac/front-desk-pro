import { useEffect, useRef } from "react";
import { gsap } from "gsap";

import "./EstimateReel.css";

import dogGroomingPhoto from "@/assets/dog-grooming-van.png";
import poolMaintenancePhoto from "@/assets/pool-maintenance.png";
import underSinkPhoto from "@/assets/plumber-under-sink.jpg";
import breakerPanelPhoto from "@/assets/electrical-panel-repair.png";
import houseCleaningPhoto from "@/assets/house-cleaning.png";
import landscapingPhoto from "@/assets/landscaping-cleanup.png";
import hvacPhoto from "@/assets/hvac-repair.png";
import applianceRepairPhoto from "@/assets/appliance-repair.png";
import paintingPhoto from "@/assets/interior-painting.png";
import autoDetailingPhoto from "@/assets/auto-detailing-interior.png";
import handymanPhoto from "@/assets/tv-mount-handyman.png";

type Slide = {
  photo: string;
  alt: string;
  sentAfter: string;
  category: string;
  title: string;
  lineItems: { label: string; amount: string }[];
  total: string;
  bgLight: string;
  bgDark: string;
};

const SLIDES: Slide[] = [
  {
    photo: dogGroomingPhoto,
    alt: "Mobile groomer working on a small dog inside a grooming van",
    sentAfter: "3 min after photo",
    category: "Pet grooming",
    title: "Full groom — small dog",
    lineItems: [
      { label: "Bath, cut & styling", amount: "$100" },
      { label: "Nail, ear & sanitary trim", amount: "$40" },
      { label: "Labor · 1 hr @ $75", amount: "$75" },
    ],
    total: "$215",
    bgLight: "#f5e6e2",
    bgDark: "#2a221e",
  },
  {
    photo: poolMaintenancePhoto,
    alt: "Pool technician skimming and netting debris from a backyard pool",
    sentAfter: "2 min after photo",
    category: "Pool maintenance",
    title: "Pool cleaning & maintenance",
    lineItems: [
      { label: "Skim, brush & vacuum", amount: "$75" },
      { label: "Chemical balance & test", amount: "$35" },
      { label: "Labor · 1 hr @ $65", amount: "$65" },
    ],
    total: "$175",
    bgLight: "#dcebee",
    bgDark: "#1b2528",
  },
  {
    photo: underSinkPhoto,
    alt: "Plumber working under a kitchen sink",
    sentAfter: "4 min after photo",
    category: "Plumbing",
    title: "P-trap rebuild",
    lineItems: [
      { label: "P-trap rebuild (parts + labor)", amount: "$145" },
      { label: "Labor · 1 hr @ $75", amount: "$75" },
    ],
    total: "$220",
    bgLight: "#e6ebe6",
    bgDark: "#212420",
  },
  {
    photo: breakerPanelPhoto,
    alt: "Electrician repairing a breaker panel",
    sentAfter: "5 min after photo",
    category: "Electrical",
    title: "Breaker panel repair",
    lineItems: [
      { label: "Breaker replacement", amount: "$140" },
      { label: "Labor · 1 hr @ $125", amount: "$125" },
    ],
    total: "$265",
    bgLight: "#f1e6d4",
    bgDark: "#29231a",
  },
  {
    photo: houseCleaningPhoto,
    alt: "Cleaner wiping down a kitchen countertop during a move-out clean",
    sentAfter: "3 min after photo",
    category: "House cleaning",
    title: "Move-out deep clean",
    lineItems: [
      { label: "Full deep clean (2BR apartment)", amount: "$220" },
      { label: "Inside oven & fridge", amount: "$45" },
      { label: "Labor · 1 hr @ $50", amount: "$50" },
    ],
    total: "$315",
    bgLight: "#e3eaee",
    bgDark: "#1f2326",
  },
  {
    photo: landscapingPhoto,
    alt: "Landscaper trimming an overgrown hedge line",
    sentAfter: "6 min after photo",
    category: "Landscaping",
    title: "Overgrown yard cleanup",
    lineItems: [
      { label: "Trim, edge & mow", amount: "$120" },
      { label: "Debris haul-away", amount: "$60" },
      { label: "Labor · 1 hr @ $65", amount: "$65" },
    ],
    total: "$245",
    bgLight: "#e6ecdd",
    bgDark: "#21241d",
  },
  {
    photo: hvacPhoto,
    alt: "HVAC technician checking refrigerant pressure on an outdoor AC unit",
    sentAfter: "4 min after photo",
    category: "HVAC",
    title: "AC not cooling",
    lineItems: [
      { label: "Diagnostic & refrigerant check", amount: "$95" },
      { label: "Refrigerant recharge", amount: "$180" },
      { label: "Labor · 1 hr @ $125", amount: "$125" },
    ],
    total: "$400",
    bgLight: "#e1e7ee",
    bgDark: "#1e2226",
  },
  {
    photo: applianceRepairPhoto,
    alt: "Technician repairing the back panel of a washing machine",
    sentAfter: "5 min after photo",
    category: "Appliance repair",
    title: "Washer not draining",
    lineItems: [
      { label: "Drain pump replacement", amount: "$145" },
      { label: "Labor · 1 hr @ $110", amount: "$110" },
    ],
    total: "$255",
    bgLight: "#ece2e6",
    bgDark: "#262024",
  },
  {
    photo: paintingPhoto,
    alt: "Painter rolling warm gray paint on an interior wall",
    sentAfter: "3 min after photo",
    category: "Painting",
    title: "Interior room repaint",
    lineItems: [
      { label: "Prep, tape & patch", amount: "$60" },
      { label: "Paint & materials", amount: "$150" },
      { label: "Labor · 3 hrs @ $60", amount: "$180" },
    ],
    total: "$390",
    bgLight: "#ede3ee",
    bgDark: "#262025",
  },
  {
    photo: autoDetailingPhoto,
    alt: "Detailer wiping down a car's interior panel",
    sentAfter: "4 min after photo",
    category: "Auto detailing",
    title: "Full interior detail",
    lineItems: [
      { label: "Interior deep clean", amount: "$120" },
      { label: "Leather conditioning", amount: "$40" },
      { label: "Labor · 1.5 hrs @ $60", amount: "$90" },
    ],
    total: "$250",
    bgLight: "#dfe3e6",
    bgDark: "#1e2022",
  },
  {
    photo: handymanPhoto,
    alt: "Handyman drilling a TV wall mount bracket into place",
    sentAfter: "2 min after photo",
    category: "Handyman",
    title: "TV mount + furniture assembly",
    lineItems: [
      { label: "TV wall mount (up to 65\")", amount: "$85" },
      { label: "Furniture assembly (1 piece)", amount: "$65" },
      { label: "Labor · 1 hr @ $75", amount: "$75" },
    ],
    total: "$225",
    bgLight: "#f1e9d9",
    bgDark: "#29251a",
  },
];

const ADVANCE_MS = 3600;

export function EstimateReel() {
  const screenRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const indexRef = useRef(0);
  const animatingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const slides = slideRefs.current;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function isDark() {
      const explicit = document.documentElement.getAttribute("data-theme");
      if (explicit === "dark") return true;
      if (explicit === "light") return false;
      return darkQuery.matches;
    }

    function applyBg(i: number) {
      const screen = screenRef.current;
      const slide = SLIDES[i];
      if (!screen || !slide) return;
      screen.style.setProperty("--er-dynamic-bg", isDark() ? slide.bgDark : slide.bgLight);
    }

    function updateDots(i: number) {
      dotRefs.current.forEach((dot, di) => {
        dot?.setAttribute("aria-current", di === i ? "true" : "false");
      });
    }

    // Initial stacked state — only the first card visible, the rest parked
    // just off to the right, ready to slide in.
    slides.forEach((slide, i) => {
      if (!slide) return;
      gsap.set(slide, {
        opacity: i === 0 ? 1 : 0,
        x: i === 0 ? 0 : 24,
        scale: i === 0 ? 1 : 0.97,
        zIndex: i === 0 ? 2 : 1,
      });
    });
    applyBg(0);

    function goTo(newIndex: number) {
      const count = SLIDES.length;
      newIndex = ((newIndex % count) + count) % count;
      if (newIndex === indexRef.current || animatingRef.current) return;

      const oldSlide = slides[indexRef.current];
      const newSlide = slides[newIndex];
      applyBg(newIndex);
      indexRef.current = newIndex;
      updateDots(newIndex);
      if (!oldSlide || !newSlide) return;

      if (prefersReduced) {
        gsap.set(oldSlide, { opacity: 0 });
        gsap.set(newSlide, { opacity: 1, x: 0, scale: 1 });
        return;
      }

      animatingRef.current = true;
      gsap.set(newSlide, { opacity: 0, x: 30, scale: 0.965, zIndex: 2 });
      gsap.set(oldSlide, { zIndex: 1 });
      const tl = gsap.timeline({
        onComplete: () => {
          gsap.set(oldSlide, { opacity: 0, x: 24, scale: 0.97 });
          animatingRef.current = false;
        },
      });
      tl.to(oldSlide, { x: -26, opacity: 0, scale: 0.975, duration: 0.5, ease: "power2.inOut" }, 0);
      tl.to(newSlide, { x: 0, opacity: 1, scale: 1, duration: 0.62, ease: "power3.out" }, 0.06);
    }

    function next() {
      goTo(indexRef.current + 1);
    }

    function restart() {
      if (timerRef.current) clearInterval(timerRef.current);
      if (!prefersReduced) timerRef.current = setInterval(next, ADVANCE_MS);
    }

    const handleThemeChange = () => applyBg(indexRef.current);
    darkQuery.addEventListener?.("change", handleThemeChange);

    dotRefs.current.forEach((dot, i) => {
      dot?.addEventListener("click", () => {
        goTo(i);
        restart();
      });
    });

    restart();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      darkQuery.removeEventListener?.("change", handleThemeChange);
    };
  }, []);

  return (
    <div className="estimate-reel">
      <div className="phone-stage">
        <div className="phone">
          <div className="screen" ref={screenRef}>
            <div className="app-header">
              <span className="word">
                Job It <span>Ready</span>
              </span>
              <span className="count">Recent estimates</span>
            </div>
            <div className="track">
              {SLIDES.map((slide, i) => (
                <div
                  key={slide.title}
                  className="er-slide"
                  ref={(el) => {
                    slideRefs.current[i] = el;
                  }}
                >
                  <div className="er-card">
                    <div className="slide-photo">
                      <img src={slide.photo} alt={slide.alt} loading={i === 0 ? "eager" : "lazy"} />
                      <span className="er-badge">Sent {slide.sentAfter}</span>
                      <span className="er-avatar">J</span>
                    </div>
                    <div className="er-estimate">
                      <div className="er-eyebrow">{slide.category}</div>
                      <h3>{slide.title}</h3>
                      {slide.lineItems.map((item) => (
                        <div className="er-line" key={item.label}>
                          <span>{item.label}</span>
                          <span>{item.amount}</span>
                        </div>
                      ))}
                      <div className="er-divider" />
                      <div className="er-total-row">
                        <span className="label">Total</span>
                        <span className="amount">{slide.total}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="er-dots">
              {SLIDES.map((slide, i) => (
                <button
                  key={slide.title}
                  type="button"
                  className="er-dot"
                  aria-label={`Go to estimate ${i + 1}`}
                  aria-current={i === 0 ? "true" : "false"}
                  ref={(el) => {
                    dotRefs.current[i] = el;
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
