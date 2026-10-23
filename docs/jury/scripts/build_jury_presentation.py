#!/usr/bin/env python3
"""build_jury_presentation.py -- Builds professional 16:9 widescreen PPTX for Jury Defense.
Generates docs/jury/JURY_PRESENTATION.pptx (10 Core Slides + 8 Appendix Slides).
"""

import sys
import os
import subprocess
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE

PPTX_OUT = Path("docs/jury/JURY_PRESENTATION.pptx")
PDF_OUT = Path("docs/jury/JURY_PRESENTATION.pdf")
SCREENS = Path("docs/jury/screens")

# Palette
DARK_TEAL = RGBColor(0x12, 0x3A, 0x40)
DEEP_BG = RGBColor(0x0F, 0x2C, 0x31)
LIGHT_BG = RGBColor(0xF8, 0xFA, 0xFC)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
ACCENT_TEAL = RGBColor(0x0F, 0x76, 0x6E)
SOFT_TEAL = RGBColor(0xCC, 0xFB, 0xF1)
DARK_TEXT = RGBColor(0x1E, 0x29, 0x3B)
MUTED_TEXT = RGBColor(0x64, 0x74, 0x8B)
ALERT_RED = RGBColor(0xBE, 0x12, 0x3C)
AMBER = RGBColor(0xD9, 0x77, 0x06)

def create_deck():
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank_layout = prs.slide_layouts[6] # blank layout

    def add_bg(slide, color):
        bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(13.333), Inches(7.5))
        bg.fill.solid()
        bg.fill.fore_color.rgb = color
        bg.line.fill.background()
        return bg

    def add_header(slide, speaker, title, subtitle=None, is_dark=False):
        tb = slide.shapes.add_textbox(Inches(0.8), Inches(0.4), Inches(11.733), Inches(1.2))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_top = tf.margin_right = tf.margin_bottom = 0

        # Speaker tag
        p_spk = tf.paragraphs[0]
        p_spk.text = f"PRESENTER: {speaker.upper()}  ·  T2D GLUCOSE DIGITAL TWIN"
        p_spk.font.size = Pt(11)
        p_spk.font.bold = True
        p_spk.font.color.rgb = SOFT_TEAL if is_dark else ACCENT_TEAL

        # Title
        p_title = tf.add_paragraph()
        p_title.text = title
        p_title.font.size = Pt(26)
        p_title.font.bold = True
        p_title.font.color.rgb = WHITE if is_dark else DARK_TEAL
        p_title.space_after = Pt(2)

        if subtitle:
            p_sub = tf.add_paragraph()
            p_sub.text = subtitle
            p_sub.font.size = Pt(13)
            p_sub.font.color.rgb = RGBColor(0xCB, 0xD5, 0xE1) if is_dark else MUTED_TEXT

    # =========================================================================
    # SLIDE 1: Title & Scope (Akshaya & Nikhil)
    # =========================================================================
    s1 = prs.slides.add_slide(blank_layout)
    add_bg(s1, DEEP_BG)

    tb = s1.shapes.add_textbox(Inches(0.8), Inches(1.2), Inches(11.733), Inches(4.5))
    tf = tb.text_frame
    tf.word_wrap = True

    p = tf.paragraphs[0]
    p.text = "HAPPIEST HEALTH DIGITAL TWIN CHALLENGE  ·  EXPERT JURY DEFENSE"
    p.font.size = Pt(12)
    p.font.bold = True
    p.font.color.rgb = SOFT_TEAL
    p.space_after = Pt(16)

    p = tf.add_paragraph()
    p.text = "T2D Glucose Digital Twin"
    p.font.size = Pt(40)
    p.font.bold = True
    p.font.color.rgb = WHITE
    p.space_after = Pt(10)

    p = tf.add_paragraph()
    p.text = "A physiology-informed digital twin forecasting 2-hour glucose trajectories\nand stating exactly what its evidence does and does not prove."
    p.font.size = Pt(18)
    p.font.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    p.space_after = Pt(28)

    p = tf.add_paragraph()
    p.text = "Team: Akshaya R (BGSIT) & Nikhil VS (EWIT)  ·  Bangalore, Karnataka\nScope: Research Prototype Only  ·  Not for Clinical Treatment Decisions"
    p.font.size = Pt(13)
    p.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)

    s1.notes_slide.notes_text_frame.text = (
        "Akshaya & Nikhil Opening:\n"
        "'Good morning, esteemed members of the jury. I am Akshaya R from BGSIT, and with me is Nikhil VS from EWIT. "
        "We are presenting the T2D Glucose Digital Twin. Our project addresses a fundamental clinical problem in type 2 diabetes: "
        "commercial monitors alert after a glucose spike happens. We built a physiology-informed digital twin that forecasts the next "
        "two hours ahead, explains how its predictions are made, and transparently discloses what its evidence proves and what failed.'"
    )

    # =========================================================================
    # SLIDE 2: The Healthcare Problem (Akshaya)
    # =========================================================================
    s2 = prs.slides.add_slide(blank_layout)
    add_bg(s2, LIGHT_BG)
    add_header(s2, "Akshaya", "The Clinical Problem: Reactive Alarms vs. Actionable Windows",
               "Why postprandial glucose prediction matters in type 2 diabetes, and why it is not medical advice.")

    # Left Card
    b1 = s2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(1.8), Inches(5.6), Inches(4.8))
    b1.fill.solid(); b1.fill.fore_color.rgb = WHITE; b1.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf1 = b1.text_frame; tf1.word_wrap = True; tf1.margin_left = tf1.margin_top = Inches(0.3)
    p = tf1.paragraphs[0]; p.text = "Current Reality: Reactive Threshold Alarms"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = ALERT_RED; p.space_after = Pt(12)
    bullets1 = [
        "CGMs measure interstitial glucose every 5 minutes (5–15 min lag behind blood).",
        "Commercial alarms beep only AFTER glucose crosses 180 mg/dL.",
        "By then, carbohydrate absorption is in full progress.",
        "The practical window for behavioral intervention (e.g. a 15-min walk) has already closed.",
        "Patients experience alert fatigue from reactive alarms with high false-alert rates."
    ]
    for b in bullets1:
        p = tf1.add_paragraph(); p.text = "• " + b; p.font.size = Pt(12.5); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(8)

    # Right Card
    b2 = s2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(6.8), Inches(1.8), Inches(5.7), Inches(4.8))
    b2.fill.solid(); b2.fill.fore_color.rgb = WHITE; b2.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf2 = b2.text_frame; tf2.word_wrap = True; tf2.margin_left = tf2.margin_top = Inches(0.3)
    p = tf2.paragraphs[0]; p.text = "Our Objective: 30–60 Minute Advance Forecast"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = ACCENT_TEAL; p.space_after = Pt(12)
    bullets2 = [
        "Forecast continuous trajectory 120 minutes ahead with confidence intervals.",
        "Alert 30–60 minutes BEFORE crossing 180 mg/dL to enable non-drug action.",
        "Exercise activates GLUT4 muscle glucose uptake before the peak occurs.",
        "Strict False-Alert Budget: Keep false alarms ≤ 1.0 per patient-day to prevent fatigue.",
        "Crucial Distinction: Predictions are conditional estimates, NOT clinical prescriptions."
    ]
    for b in bullets2:
        p = tf2.add_paragraph(); p.text = "• " + b; p.font.size = Pt(12.5); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(8)

    s2.notes_slide.notes_text_frame.text = (
        "Akshaya:\n"
        "'A continuous glucose monitor measures interstitial fluid under the skin. Today, if a patient eats lunch, the monitor is silent "
        "until their glucose crosses 180 mg/dL. That is a reactive alarm. In type 2 diabetes, light exercise like a 20-minute walk clears "
        "glucose via muscle GLUT4 transporters, but it works best before the spike peaks. We set out to give patients a 30- to 60-minute "
        "early warning. But we are very clear: a forecast is not a prescription. We never claim this prototype treats diabetes.'"
    )

    # =========================================================================
    # SLIDE 3: Our Solution (Nikhil)
    # =========================================================================
    s3 = prs.slides.add_slide(blank_layout)
    add_bg(s3, LIGHT_BG)
    add_header(s3, "Nikhil", "Our Solution: A Physiology-Informed Digital Twin Workstation",
               "Coupling biophysical ODEs with attention transformers behind a production clinical UI.")

    # 3 Column Cards
    col_w = Inches(3.64)
    c1 = s3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(1.8), col_w, Inches(4.8))
    c1.fill.solid(); c1.fill.fore_color.rgb = WHITE; c1.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = c1.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "1. Physiology Twin"; p.font.size = Pt(15); p.font.bold = True; p.font.color.rgb = ACCENT_TEAL; p.space_after = Pt(8)
    for b in ["Modified Bergman Minimal ODEs model glucose clearance and gut absorption.",
              "Unscented Kalman Filter (UKF) recursively updates insulin action & sensitivity.",
              "Generates smooth, biologically plausible 2-hour mechanistic baseline."]:
        p = tf.add_paragraph(); p.text = "• " + b; p.font.size = Pt(12); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(6)

    c2 = s3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(4.84), Inches(1.8), col_w, Inches(4.8))
    c2.fill.solid(); c2.fill.fore_color.rgb = WHITE; c2.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = c2.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "2. Learned PR-TFT"; p.font.size = Pt(15); p.font.bold = True; p.font.color.rgb = ACCENT_TEAL; p.space_after = Pt(8)
    for b in ["Temporal Fusion Transformer learns strictly the residual the physics misses.",
              "Consumes EHR context, 24-hr wearable history (HR, steps, sleep), and clock.",
              "Predicts 7 quantiles (P05–P95) with conformal coverage & calibrated hazard."]:
        p = tf.add_paragraph(); p.text = "• " + b; p.font.size = Pt(12); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(6)

    c3 = s3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.88), Inches(1.8), col_w, Inches(4.8))
    c3.fill.solid(); c3.fill.fore_color.rgb = WHITE; c3.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = c3.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "3. Clinical Workstation"; p.font.size = Pt(15); p.font.bold = True; p.font.color.rgb = ACCENT_TEAL; p.space_after = Pt(8)
    for b in ["Next.js 15 UI with Ward Triage and time-scrubbing replay navigation.",
              "What-If counterfactual scenario re-runs (meals, walking; refuses drugs).",
              "Bilingual patient note (English/Hindi) and official HL7 FHIR R4 export."]:
        p = tf.add_paragraph(); p.text = "• " + b; p.font.size = Pt(12); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(6)

    s3.notes_slide.notes_text_frame.text = (
        "Nikhil:\n"
        "'To solve this, we did not build a generic black-box neural network. We built a hybrid digital twin in three parts. "
        "First, a biophysical model based on Bergman equations tracked by an Unscented Kalman Filter. It sets the biological baseline. "
        "Second, a Temporal Fusion Transformer that learns strictly the residual error the physics misses—like circadian rhythms and exertion. "
        "And third, a clinical workstation where doctors can triage patients, scrub through time, and explore What-If changes.'"
    )

    # =========================================================================
    # SLIDE 4: How It Works — Architecture (Nikhil)
    # =========================================================================
    s4 = prs.slides.add_slide(blank_layout)
    add_bg(s4, LIGHT_BG)
    add_header(s4, "Nikhil", "How It Works: Causal Architecture & Data Flow",
               "Every forecast is an explicit sum: Twin Baseline + Learned Residual.")

    # Image left
    img_path = str(SCREENS / "landing-pipeline.png")
    if os.path.exists(img_path):
        s4.shapes.add_picture(img_path, Inches(0.8), Inches(1.8), Inches(6.8), Inches(4.8))

    # Text right
    card = s4.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(7.9), Inches(1.8), Inches(4.6), Inches(4.8))
    card.fill.solid(); card.fill.fore_color.rgb = WHITE; card.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = card.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "Mathematical Pipeline"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = DARK_TEAL; p.space_after = Pt(10)
    steps = [
        "1. Input Ingestion: 5-min CGM + static EHR (Age, BMI, HbA1c, eGFR) + wearables.",
        "2. UKF Twin Rollout: Solves Bergman ODEs to produce mechanistic trajectory baseline.",
        "3. Residual Attention: PR-TFT predicts delta ΔG across 7 quantiles (P05–P95).",
        "4. Additive Composition: Final Forecast = Twin Rollout + Learned Adjustment.",
        "5. Conformal Bounds: Empirical non-conformity guarantees 80% validation coverage.",
        "6. Fallback Protection: If ML fails, system falls back to twin-only rollout."
    ]
    for s in steps:
        p = tf.add_paragraph(); p.text = s; p.font.size = Pt(11); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(6)

    s4.notes_slide.notes_text_frame.text = (
        "Nikhil:\n"
        "'Here is our data flow. We ingest 5-minute CGM and wearable streams through an observable contract. "
        "The Unscented Kalman Filter updates the patient's internal physiological state and projects a 2-hour physics rollout. "
        "The Temporal Fusion Transformer looks at the past 24 hours and predicts the residual adjustment. "
        "The final forecast is literally Twin plus Learned Adjustment. If the machine learning model ever fails, "
        "the backend automatically falls back to serving the physics twin alone. Nothing runs black-box.'"
    )

    # =========================================================================
    # SLIDE 5: Live Workstation (Akshaya)
    # =========================================================================
    s5 = prs.slides.add_slide(blank_layout)
    add_bg(s5, LIGHT_BG)
    add_header(s5, "Akshaya", "Live Workstation: Verified Prototype on Synthetic Cohort",
               "Real-time streaming replay of 249 served subjects; test partition strictly sealed.")

    # Image left
    img_path = str(SCREENS / "landing-hero.png")
    if os.path.exists(img_path):
        s5.shapes.add_picture(img_path, Inches(0.8), Inches(1.8), Inches(7.5), Inches(4.8))

    # Text right
    card = s5.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.6), Inches(1.8), Inches(3.9), Inches(4.8))
    card.fill.solid(); card.fill.fore_color.rgb = WHITE; card.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = card.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "Verified Features"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = DARK_TEAL; p.space_after = Pt(10)
    feats = [
        "Live Hero (P0017): 53yo male with T2D replayed at 08:00 UTC.",
        "On-Screen Math: Twin (232.5) + Adjustment (−15.4) = 217.1 mg/dL at +60m.",
        "Ward Triage View: Ranks patients by 2-hour spike-onset hazard.",
        "Timeline Pinning: Freeze historical moments without lookahead bias.",
        "Sealed Partition Guard: 44 test subjects return HTTP 404 (never exposed)."
    ]
    for f in feats:
        p = tf.add_paragraph(); p.text = "• " + f; p.font.size = Pt(11.5); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(8)

    s5.notes_slide.notes_text_frame.text = (
        "Akshaya:\n"
        "'This is our live running application. On screen is patient P0017 from our validation cohort. "
        "Notice the decomposition strip right below the heading: at plus 60 minutes, the physics twin says 232.5 mg/dL, "
        "the neural network subtracts 15.4, giving a final forecast of 217.1 mg/dL with its 80% conformal interval. "
        "The cohort page serves 249 synthetic subjects, while our 44 held-out test subjects are completely locked away.'"
    )

    # =========================================================================
    # SLIDE 6: The Prediction & Uncertainty (Nikhil)
    # =========================================================================
    s6 = prs.slides.add_slide(blank_layout)
    add_bg(s6, LIGHT_BG)
    add_header(s6, "Nikhil", "Uncertainty & What-If Counterfactual Simulation",
               "Conformal intervals, calibrated hazard, and principled scenario exploration.")

    # Image left
    img_path = str(SCREENS / "whatif-meal-result.png")
    if os.path.exists(img_path):
        s6.shapes.add_picture(img_path, Inches(0.8), Inches(1.8), Inches(7.5), Inches(4.8))

    # Text right
    card = s6.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.6), Inches(1.8), Inches(3.9), Inches(4.8))
    card.fill.solid(); card.fill.fore_color.rgb = WHITE; card.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = card.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "What-If Dynamics"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = DARK_TEAL; p.space_after = Pt(10)
    items = [
        "Add 60g Carbs in 30m: Mechanistic gut rollout raises glucose; network adjusts.",
        "Add 30m Walking: Elevates glucose clearance via exercise uptake.",
        "Medication Refusal: Clicking drug changes returns SCENARIO_UNSUPPORTED.",
        "Visible Artefact Flag: Circled 5-min blip is flagged, never silently smoothed.",
        "Causal Caveat: What-If is a simulated response, not a proven clinical outcome."
    ]
    for it in items:
        p = tf.add_paragraph(); p.text = "• " + it; p.font.size = Pt(11.5); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(8)

    s6.notes_slide.notes_text_frame.text = (
        "Nikhil:\n"
        "'A digital twin should allow interactive exploration. In our What-If panel, a clinician can test adding a 60-gram carb meal "
        "or 30 minutes of walking. But we enforce strict boundaries: if you click medication changes, the backend refuses with "
        "SCENARIO_UNSUPPORTED because the twin has no validated drug models. And look at Figure 3: when the neural network produces "
        "a single-step 5-minute blip, we do not smooth it out. We circle it and warn the user. Honest software flags its artefacts.'"
    )

    # =========================================================================
    # SLIDE 7: Evidence — Locked Real-Patient Evaluation (Akshaya)
    # =========================================================================
    s7 = prs.slides.add_slide(blank_layout)
    add_bg(s7, LIGHT_BG)
    add_header(s7, "Akshaya", "Evidence: Locked Evaluation on 161 Real Patients",
               "Primary locked test results on 11 held-out test patients with 5-minute CGM.")

    # Image left
    img_path = str(SCREENS / "evidence-alarms-and-real161.png")
    if os.path.exists(img_path):
        s7.shapes.add_picture(img_path, Inches(0.8), Inches(1.8), Inches(7.5), Inches(4.8))

    # Text right
    card = s7.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.6), Inches(1.8), Inches(3.9), Inches(4.8))
    card.fill.solid(); card.fill.fore_color.rgb = WHITE; card.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = card.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "Key Verified Numbers"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = ACCENT_TEAL; p.space_after = Pt(10)
    pts = [
        "60-min RMSE: 23.11 mg/dL [18.75–28.12] (Persistence: 26.27 mg/dL).",
        "False Alerts: 0.11 / patient-day (within ≤ 1.0 budget).",
        "Alert Precision: 65.5% (Linear trend: only 16.4%).",
        "Early Sensitivity (≥30m): 6.9% point est. / 6.0% bootstrap mean.",
        "ShanghaiT2DM: Declared NOT ESTIMABLE (15-min cadence violates 70% rule)."
    ]
    for pt in pts:
        p = tf.add_paragraph(); p.text = "• " + pt; p.font.size = Pt(11.5); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(8)

    s7.notes_slide.notes_text_frame.text = (
        "Akshaya:\n"
        "'Now let us examine our real-patient evidence. We conducted a single locked test evaluation across 161 real patients from "
        "three open datasets. On the 11 held-out test patients with native 5-minute CGM, our hybrid achieved a 60-minute RMSE of 23.11 mg/dL, "
        "beating persistence and the physics twin. It held false alerts down to 0.11 per day with 65.5% precision. "
        "The simple linear trend caught more spikes, but at 3.84 false alerts a day—which causes unbearable alert fatigue. "
        "And ShanghaiT2DM was honestly declared Not Estimable because 15-minute readings cannot test 5-minute persistence.'"
    )

    # =========================================================================
    # SLIDE 8: What Failed and What We Learned (Nikhil)
    # =========================================================================
    s8 = prs.slides.add_slide(blank_layout)
    add_bg(s8, LIGHT_BG)
    add_header(s8, "Nikhil", "What Failed & What We Learned: Honest Science",
               "Negative results, failed gates, and external validation checks.")

    # Image left
    img_path = str(SCREENS / "evidence-real-external-tables.png")
    if os.path.exists(img_path):
        s8.shapes.add_picture(img_path, Inches(0.8), Inches(1.8), Inches(7.5), Inches(4.8))

    # Text right
    card = s8.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.6), Inches(1.8), Inches(3.9), Inches(4.8))
    card.fill.solid(); card.fill.fore_color.rgb = WHITE; card.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = card.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "Failed Gates Disclosed"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = ALERT_RED; p.space_after = Pt(10)
    negatives = [
        "Gate 3 Realism Audit: FAILED (AUROC 0.932 vs ≤0.65 target; ODE traces too smooth).",
        "Real Early Warning (6.9%): Low advance sensitivity due to unannounced meals.",
        "External Check 1 (Hall 2018): NOT CONFIRMED (+7.8%, 95% CI crosses 0).",
        "External Check 2 (AZT1D): NOT MET (Learned model −2.5% vs linear trend).",
        "Lesson: Probability thresholds do not transfer across cohorts without local recalibration."
    ]
    for n in negatives:
        p = tf.add_paragraph(); p.text = "• " + n; p.font.size = Pt(11.5); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(8)

    s8.notes_slide.notes_text_frame.text = (
        "Nikhil:\n"
        "'A presentation without negative results is not science. We openly report where our system failed. "
        "First, our synthetic realism test failed with AUROC 0.932 because our ODEs were smoother than real CGMs. "
        "Second, on real patients without contemporaneous meal logs, our 30-minute early warning sensitivity was only 6.9%. "
        "Third, on two external cohorts—Hall and AZT1D—our learned models failed to statistically beat simple trend rules. "
        "We learned that fixed probability thresholds do not generalize across different populations without local recalibration.'"
    )

    # =========================================================================
    # SLIDE 9: Engineering, Safety & Reproducibility (Akshaya)
    # =========================================================================
    s9 = prs.slides.add_slide(blank_layout)
    add_bg(s9, LIGHT_BG)
    add_header(s9, "Akshaya", "Engineering Rigor, Safety Governance & Interoperability",
               "Test split firewalls, HL7 FHIR R4 export, and containerized deployment.")

    # Image left
    img_path = str(SCREENS / "clinician-summary-modal.png")
    if os.path.exists(img_path):
        s9.shapes.add_picture(img_path, Inches(0.8), Inches(1.8), Inches(7.5), Inches(4.8))

    # Text right
    card = s9.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.6), Inches(1.8), Inches(3.9), Inches(4.8))
    card.fill.solid(); card.fill.fore_color.rgb = WHITE; card.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
    tf = card.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.25)
    p = tf.paragraphs[0]; p.text = "Clinical Integration"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = DARK_TEAL; p.space_after = Pt(10)
    items = [
        "Partition Firewall: Sealed test partition isolated at API boundary (HTTP 404).",
        "HL7 FHIR R4: Validated JSON export using LOINC 99504-3 and HTEST security tag.",
        "Bilingual Note: Plain English and Hindi patient summaries.",
        "Reproducibility: Git SHA commit tracking, deterministic seeds, and run manifests.",
        "Zero Real Data Leakage: Real patient datasets stored offline only."
    ]
    for it in items:
        p = tf.add_paragraph(); p.text = "• " + it; p.font.size = Pt(11.5); p.font.color.rgb = DARK_TEXT; p.space_after = Pt(8)

    s9.notes_slide.notes_text_frame.text = (
        "Akshaya:\n"
        "'From a software engineering perspective, this project is built for healthcare reality. "
        "Our clinician export generates an official HL7 FHIR R4 JSON bundle tagged with LOINC 99504-3 and HTEST test-data labels. "
        "We support bilingual patient summaries in English and Hindi. Our test partitions are strictly firewalled in code, "
        "and every single number in our presentation is traceable to a hashed, committed artifact in the GitHub repository.'"
    )

    # =========================================================================
    # SLIDE 10: Conclusion & Roadmap (Akshaya & Nikhil)
    # =========================================================================
    s10 = prs.slides.add_slide(blank_layout)
    add_bg(s10, DEEP_BG)
    add_header(s10, "Akshaya & Nikhil", "Conclusion & Next Steps: The Path to Clinical Translation",
               "What we proved, what remains, and our evidence-justified research roadmap.", is_dark=True)

    # Left Box
    b1 = s10.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(1.8), Inches(5.6), Inches(4.8))
    b1.fill.solid(); b1.fill.fore_color.rgb = RGBColor(0x1E, 0x3A, 0x40); b1.line.color.rgb = RGBColor(0x0F, 0x76, 0x6E)
    tf1 = b1.text_frame; tf1.word_wrap = True; tf1.margin_left = tf1.margin_top = Inches(0.3)
    p = tf1.paragraphs[0]; p.text = "What We Have Proven"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = SOFT_TEAL; p.space_after = Pt(12)
    provs = [
        "A working, reproducible digital twin combining biophysical ODEs with PR-TFT attention.",
        "A 16.0% RMSE reduction over the physics twin on synthetic validation data.",
        "A 60-min RMSE of 23.11 mg/dL on held-out real patients within a 0.11 false alert/day budget.",
        "Full-stack clinical workstation with FHIR export, What-If simulation, and sealed partition guards.",
        "Uncompromising scientific integrity: failed gates and negative findings published openly."
    ]
    for pr in provs:
        p = tf1.add_paragraph(); p.text = "✔ " + pr; p.font.size = Pt(12); p.font.color.rgb = WHITE; p.space_after = Pt(8)

    # Right Box
    b2 = s10.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(6.8), Inches(1.8), Inches(5.7), Inches(4.8))
    b2.fill.solid(); b2.fill.fore_color.rgb = RGBColor(0x1E, 0x3A, 0x40); b2.line.color.rgb = RGBColor(0x0F, 0x76, 0x6E)
    tf2 = b2.text_frame; tf2.word_wrap = True; tf2.margin_left = tf2.margin_top = Inches(0.3)
    p = tf2.paragraphs[0]; p.text = "Next Steps Before Clinical Use"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = AMBER; p.space_after = Pt(12)
    nexts = [
        "1. AI-READI Confirmation: Execute frozen protocol on ~944 T2D participants once data access is approved.",
        "2. Adaptive Thresholds: Implement dynamic operating points to prevent cross-cohort calibration collapse.",
        "3. Unannounced Meal Deconvolution: Infer carbohydrate arrival directly from early CGM inflections.",
        "4. Curvature Regularization: Retrain PR-TFT with smoothness loss to permanently eliminate 20 mg/dL jumps.",
        "5. Observational Clinical Pilot: Evaluate clinician decision support in outpatient type 2 reviews."
    ]
    for nx in nexts:
        p = tf2.add_paragraph(); p.text = "➔ " + nx; p.font.size = Pt(12); p.font.color.rgb = WHITE; p.space_after = Pt(8)

    s10.notes_slide.notes_text_frame.text = (
        "Akshaya & Nikhil Closing:\n"
        "'In conclusion, we have built a working, transparent, and reproducible digital twin. "
        "We did not overclaim, we did not hide our failures, and we proved that physiological priors enhance deep learning stability. "
        "Before this can ever enter clinical care, it needs validation on large datasets like AI-READI and prospective clinical trials. "
        "Thank you, and we look forward to your questions.'"
    )

    # =========================================================================
    # APPENDIX SLIDES (11–18)
    # =========================================================================
    app_titles = [
        ("Slide 11: Appendix — Bergman Minimal Model & UKF Equations", [
            "Glucose dynamics: dG/dt = −[p1 + X(t)] G(t) + p1 Gb + (1/VG) Ra(t)",
            "Remote insulin action: dX/dt = −p2 X(t) + p3 [I(t) − Ib]",
            "Gut absorption: Two-compartment model dQ1/dt = −k_gri Q1 + Meals; dQ2/dt = k_gri Q1 − k_abs Q2",
            "UKF State Vector: [G, X, I, Q1, Q2, SI, EGP] tracked recursively with sigma points.",
            "State prior prevents unphysical negative glucose or runaway exponential spikes during dropouts."
        ]),
        ("Slide 12: Appendix — PR-TFT Architecture & Hyperparameters", [
            "Architecture: Temporal Fusion Transformer with Gated Residual Networks (GRN) and Variable Selection Networks (VSN).",
            "Hidden dimension: 96; Attention heads: 4; Layers: 2; Dropout: 0.1.",
            "Inputs: Static EHR (Age, BMI, HbA1c, eGFR) + Dynamic Wearables (CGM, HR, HRV, Steps, Sleep) + Clock features.",
            "Loss function: Pinball quantile loss across 7 quantiles (P05 to P95) + Binary cross-entropy on hazard head.",
            "Early stopping: Patience of 4 epochs on validation loss (checkpoint: epoch=03, val_loss=0.2255)."
        ]),
        ("Slide 13: Appendix — Dataset Split Accountability & Denominators", [
            "Synthetic Cohort: 293 total (205 train, 44 val, 44 test sealed). Served in app: 249 subjects.",
            "Real Benchmark: 161 nominal patients across CGMacros (45), BIG IDEAs (16), ShanghaiT2DM (100).",
            "ShanghaiT2DM: 15-minute sampling cadence violates ≥70% 5-minute coverage rule -> NOT ESTIMABLE.",
            "Evaluated Real Test Set: Exactly 11 held-out test patients with native 5-minute CGM.",
            "Zero participant-level outcome inspection was performed during development."
        ]),
        ("Slide 14: Appendix — Metric Definitions & 1-to-1 Alert Matching", [
            "Adverse Spike: Crossing ≥180 mg/dL preceded by ≥50 mg/dL rise in 60 min, persisting for ≥15 min.",
            "1-to-1 Alert Matching: An alert matches at most ONE subsequent spike event (5–120 min ahead).",
            "Refractory Cooldown: 120-minute alert suppression following any triggered alarm.",
            "Sensitivity ≥30m: Spikes caught with an alert at least 30 minutes before crossing 180 mg/dL.",
            "False Alert Budget: Maximum allowable rate is ≤ 1.0 false alert per patient-day."
        ]),
        ("Slide 15: Appendix — External Checks on Unused Cohorts (Hall & AZT1D)", [
            "Hall et al. 2018 (57 participants, 64 spikes): Routine model +7.8% [0.0, +13.2]; NOT CONFIRMED.",
            "Linear trend beat learned models on Hall (32.8% sens at 0.38 FA/day) due to low event frequency.",
            "AZT1D (24 adults with T1D on AID, 2,814 spikes): Learned model 12.5% vs Trend 15.0%; NOT MET.",
            "Risk-Gated Trend (C2): Doubled sensitivity (26.4%) but exceeded false alert budget (1.26/day).",
            "Core Takeaway: Probability calibration collapses across populations without adaptive operating points."
        ]),
        ("Slide 16: Appendix — Sealed Partition Firewall Verification", [
            "Code Location: backend/serve_pr_tft.py line 79 (SEALED_SPLITS = frozenset({'test'})).",
            "Rejection Behavior: Querying any test-split subject UUID or patient ID raises HTTP 404.",
            "Subject Directory: GET /v1/subjects filters out all test IDs at the database iterator level.",
            "Offline Isolation: Real patient files (data/real/) are excluded from Git and Docker images.",
            "No Lookahead Leakage: Timeline scrubbing strictly hides readings after the anchor timestamp."
        ]),
        ("Slide 17: Appendix — Clinical Safety, Medication Refusal & FHIR R4", [
            "Medication Refusal: What-If drug modifications return 422 SCENARIO_UNSUPPORTED.",
            "FHIR R4 Schema: Exported bundles validated against official HL7 JSON schema.",
            "Standard Codings: Interstitial glucose coded as LOINC 99504-3 with UCUM units mg/dL.",
            "HTEST Security Label: Prevents accidental ingestion into real clinical EHR databases.",
            "Bilingual Translation: English and Hindi patient summaries with explicit clinical disclaimer."
        ]),
        ("Slide 18: Appendix — Unexecuted Protocols & Research Integrity", [
            "EW-01 Protocol: Prospective early-warning trial protocol remains unexecuted and excluded from claims.",
            "AI-READI Confirmation: Frozen preregistration on FAIRhub (~944 T2D participants); awaiting data access.",
            "Frozen Harness: aireadi_evaluate.py committed and SHA-256 hashed before receiving data.",
            "No P-Hacking: All evaluations executed in a single authorized run without parameter retuning.",
            "Complete Provenance: Every claim backed by commit SHAs and locked manifest files."
        ])
    ]

    for title, bullets in app_titles:
        s = prs.slides.add_slide(blank_layout)
        add_bg(s, LIGHT_BG)
        add_header(s, "Appendix", title, "Technical reference & deep-dive material for jury questions.")

        card = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(1.8), Inches(11.733), Inches(4.8))
        card.fill.solid(); card.fill.fore_color.rgb = WHITE; card.line.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
        tf = card.text_frame; tf.word_wrap = True; tf.margin_left = tf.margin_top = Inches(0.4)

        for i, b in enumerate(bullets):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.text = "• " + b
            p.font.size = Pt(13)
            p.font.color.rgb = DARK_TEXT
            p.space_after = Pt(12)

    print(f"Saving {PPTX_OUT}...")
    prs.save(str(PPTX_OUT))
    print(f"Generated {PPTX_OUT} with {len(prs.slides)} slides.")

    # Convert to PDF
    print(f"Converting {PPTX_OUT} to PDF via LibreOffice...")
    cmd = ["/usr/bin/soffice", "--headless", "--convert-to", "pdf", "--outdir", "docs/jury", str(PPTX_OUT)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"LibreOffice conversion warning: {res.stderr}")
    else:
        print(f"Converted to {PDF_OUT} ({PDF_OUT.stat().st_size} bytes)")
        info = subprocess.run(["pdfinfo", str(PDF_OUT)], capture_output=True, text=True)
        print(info.stdout)

if __name__ == "__main__":
    create_deck()
