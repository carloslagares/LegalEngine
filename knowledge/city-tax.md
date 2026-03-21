# City Tax / Tourist Tax — European Knowledge Base

## Overview

Tourist taxes (also called city tax, accommodation tax, or tourist levy) are mandatory charges that vacation rental hosts must collect from guests and remit to local authorities. These taxes vary by country, region, and city. In Europe, they are mostly municipality-based, often charged as a fixed amount per person per night, with caps, exemptions, and in some cases category-based tiers.

## Coverage

- Properties with active tax rules observed: 10,311
- Unique cities covered: 1,314
- Countries covered: 41

## Spain

### Catalonia (Barcelona)

- **Rule type**: Fixed per person per night, tiered by accommodation category, with Barcelona municipal surcharge
- **Tourist apartments / VUT**: €12.50 per person per night (total including regional + municipal surcharge)
- **5-star / luxury hotels**: €15.00 per person per night
- **4-star hotels**: €11.40 per person per night
- **Other accommodations**: €10.00 per person per night
- **Confidence**: High for structure, medium for exact tier mapping unless accommodation category is explicitly stored

### Balearic Islands (Mallorca, Ibiza, Menorca, Formentera)

- **Rule type**: Fixed per person per night (Impuesto de Turismo Sostenible / ITS)
- **Average observed rate**: ~€1.38 per person per night
- **Properties observed**: 182
- **Rule type agreement**: 100%
- **Notes**: The Sustainable Tourism Tax (ITS) applies to all tourist accommodation. Rates may vary by accommodation category and season (high season rates may be higher). Children under 16 are typically exempt. Maximum stay subject to tax is usually capped at a certain number of nights.

### Madrid

- **Properties with tax configuration observed**: 49
- **Notes**: Madrid does not currently have a regional tourist tax, though municipal tax configurations exist in some internal systems.

### Seville

- **Properties with tax configuration observed**: 44

## Italy

### Rome
- **Properties observed**: 510
- **Rule type agreement**: 100%
- **Average rate**: ~€6.02 per person per night
- **Standard deviation**: €0.75

### Milan
- **Properties observed**: 284
- **Rule type agreement**: 100%
- **Average rate**: ~€7.62 per person per night
- **Standard deviation**: €2.39

### Lucca
- **Properties observed**: 141
- **Rule type agreement**: 100%
- **Rate**: €3.50 per person per night (fixed, no variance)

## Portugal

### Porto
- **Properties observed**: 245
- **Rule type agreement**: 100%
- **Average rate**: ~€2.02 per person per night
- **Standard deviation**: €0.15

### Lisbon
- **Properties observed**: 179
- **Rule type agreement**: 100%
- **Average rate**: ~€2.48 per person per night
- **Standard deviation**: €0.87

## Czech Republic

### Prague
- **Properties observed**: 416
- **Rule type agreement**: 100%
- **Average rate**: ~€34.48 per person per night (CZK-based, converted)
- **Standard deviation**: €22.36
- **Notes**: High variance suggests category-based pricing or mixed configurations

## France

- **Cities with tax rules in dataset**: 82
- **Properties with tax rules**: 456
- **Complexity**: Higher than most countries due to municipal + departmental + regional layers and classification-based logic
- **Top cities**: Valras-Plage (126 properties), Paris (72), Cannes (44), Sérignan (35)

## United States

- **Model**: Stacked percentage-based (not a single city tax)
- **Common layers**: State sales tax, county tax, city occupancy tax, special district / tourism improvement fees
- **Other mandatory fees**: Resort fee, destination fee, facility fee, urban fee, cleaning fee in STR contexts

## Global Complexity Notes

- **Europe**: Mostly municipality-based, often fixed per person per night, with caps, exemptions and in some cases category-based tiers
- **France**: Higher complexity due to municipal + departmental + regional layers and classification-based logic
- **USA**: Stacked percentage model rather than a single city tax

## Exemptions (Common Patterns)

- Children under a certain age (varies: under 12, under 14, or under 16 depending on jurisdiction)
- Stays exceeding maximum taxable nights (often 7-14 nights cap)
- Business travelers in some jurisdictions
- Residents of the same municipality or region

## Known Limitations

- The analyzed dataset does not explicitly include hotel star rating or official accommodation category
- Some city configurations may exist even where a formal municipal tax does not currently exist in law
- For category-driven cities, exact legal calculation requires either explicit category data or an official tier table
