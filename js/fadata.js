/* fadata.js — verified current-state foreign-affairs context for InterDesk,
   injected into every AI call so briefs and synthesis are grounded in reality,
   not model memory. Compiled and source-verified 3 Aug 2026. Anything marked
   (unconfirmed) could not be confirmed against a current source; the
   `unverified` register lists each such item with what was found instead. */
(function () {
  const DATA = {
    verifiedAsOf: "2026-08-03",

    /* Structured register of the (unconfirmed) markers embedded in the prose
       below, so the UI can surface them instead of burying the caveats in
       strings only the AI ever reads. */
    unverified: [
      {
        claim: "GCC FTA remains concluded but not in force, signature pending",
        found: "MFAT's page still lists the 31 October 2024 deal as concluded but not in force with no signing or entry-into-force date announced, but that listing could not be re-confirmed against a dated August 2026 source.",
      },
      {
        claim: "Walters on AUKUS: any decision 'must be a decision for New Zealand to take alone and independently'",
        found: "The quote is corroborated only via search snippets of the 2 April 2026 Newsroom article, which blocks direct fetching (HTTP 403).",
      },
      {
        claim: "Walters is not on Parliament's Intelligence and Security Committee",
        found: "Confirming membership lists (Labour members: Hipkins and Radhakrishnan) predate the March 2026 reshuffle, and parliament.nz's committee page was bot-blocked, so a post-reshuffle swap cannot be fully ruled out.",
      },
      {
        claim: "NZ's New Caledonia stance is unchanged since May 2025",
        found: "No 2026 NZ government statement updating the position (support for recovery and a French-led dialogue, backing the Valls talks) was found; the July 2025 Bougival Accord process has stalled amid FLNKS rejection.",
      },
    ],

    principal: {
      name: "Vanushi Walters",
      role: "Labour spokesperson for Foreign Affairs, NZSIS and GCSB; shadow attorney-general",
      since: "Portfolios assigned 11 March 2026 in Chris Hipkins' pre-election caucus reshuffle, succeeding the retiring Peeni Henare",
      seat: "Labour list MP in the 54th Parliament (returned on the list 12 May 2025 after David Parker's resignation); ranked 8th on Labour's 2026 party list (up from 12) and standing list-only rather than re-contesting Upper Harbour, which National's Cameron Brewer holds",
      background: "Sri Lankan-born, Oxford-educated human rights lawyer; worked across private practice, the public sector and NGOs, including as general manager of YouthLaw Aotearoa, manager of the Human Rights Commission's advisory and research team, and in governance roles with Amnesty International and Foundation North",
      associate: "Phil Twyford (MP for Te Atatū) is her Associate Foreign Affairs spokesperson, alongside his Immigration and Disarmament and Arms Control roles; Walters herself held the associate FA role before the reshuffle",
      isc: "Not a member of Parliament's Intelligence and Security Committee (unconfirmed): Labour's members on the confirming lists are Chris Hipkins and Priyanca Radhakrishnan, but those lists predate the March 2026 reshuffle",
    },

    positions: [
      {
        line: "The coalition Government has been \"very one-sided\" in its approach to international affairs and has struggled to consistently uphold the rules-based order.",
        source: "1News", date: "2026-03-29",
      },
      {
        line: "The Government should have condemned the US and Israeli strikes on Iran as illegal.",
        quote: "When Israel and the US invaded Iran, the Government should have called that out as a breach of the UN Charter. They didn't.",
        source: "1News", date: "2026-03-29",
      },
      {
        line: "Criticises PM Luxon's openness to AUKUS Pillar Two and his framing of New Zealand as \"a force multiplier\" for the US and Australia.",
        quote: "I don't think that serves New Zealand's interests.",
        source: "1News", date: "2026-03-29",
      },
      {
        line: "Accuses the Government of \"a clear alignment with the United States and a selective defence of the rule of law - calling out China for breaches of human rights, which we should absolutely be doing, but failing to call out the US and Israel\", while crediting its early call for a Gaza ceasefire.",
        source: "Newsroom", date: "2026-04-02",
      },
      {
        line: "(unconfirmed) On AUKUS, any decision \"must be a decision for New Zealand to take alone and independently\"; a Labour government would stay close to the US without following Trump's direction.",
        source: "Newsroom (via search snippets; the article blocks direct fetching)", date: "2026-04-02",
      },
      {
        line: "Backed the NZ-India FTA legislation for Labour - tariff cuts and \"access to an extremely large market, and we do welcome that\" - while cautioning \"this isn't an ideal deal in terms of what it excludes\" and that exporters should weigh the risk of tariffs returning in 15 years.",
        source: "Hansard via Scoop", date: "2026-06-25",
      },
    ],

    government: {
      coalition: "National-ACT-NZ First",
      ministers: [
        ["Winston Peters", "NZ First", "Foreign Affairs (held the Deputy PM role in the first half of the term under the coalition rotation; David Seymour holds it since 31 May 2025)"],
        ["Chris Penk", "National", "Defence; NZSIS and GCSB (from the 7 April 2026 reshuffle)"],
        ["Todd McClay", "National", "Trade; the only Associate Minister of Foreign Affairs on the current beehive.govt.nz ministerial list"],
        ["Christopher Luxon", "National", "Prime Minister; National Security and Intelligence"],
        ["Mark Mitchell", "National", "Associate National Security and Intelligence (April 2026)"],
        ["Paul Goldsmith", "National", "Pacific Peoples"],
      ],
      reshuffle: "Election-year reshuffle announced 2 April 2026 (effective 7 April) after Judith Collins and Shane Reti announced their retirements at the election.",
    },

    labourTeam: [
      ["Chris Hipkins", "Leader of the Opposition; announced the pre-election portfolio reshuffle 11 March 2026"],
      ["Carmel Sepuloni", "Deputy Leader; Pacific Peoples spokesperson (also Auckland Issues and Women)"],
      ["Damien O'Connor", "Defence (picked up in the March 2026 reshuffle after Peeni Henare's departure); Trade and Export Growth"],
      ["Phil Twyford", "Disarmament and Arms Control; Associate Foreign Affairs; Immigration"],
      ["Jenny Salesa", "Associate Pacific Peoples (since the March 2026 reshuffle)"],
    ],

    election: {
      dayISO: "2026-11-07",
      frame: "House rises 24 September 2026; Parliament dissolved 1 October; writ day 4 October; nominations close noon 8 October; advance voting from 26 October; election day Saturday 7 November; writ returned by 3 December.",
      collision: "UNGA-81's high-level general debate week (22-26 and 28 September) collides with the campaign: the House rises 24 September and dissolution follows within the week.",
      caretaker: "The caretaker convention governs late-term foreign commitments: significant decisions and new international obligations made close to or after the election should be deferred or taken in consultation with other parties.",
    },

    calendar: [
      { event: "PIF-55: 55th Pacific Islands Forum Leaders Meeting", place: "Koror, Palau", startISO: "2026-08-30", endISO: "2026-09-04", note: "Theme 'B.E.L.A.U - Building Economies: Life. Action. Unity.'" },
      { event: "UNGA-81 opens", place: "New York", startISO: "2026-09-08", endISO: "2026-09-08", note: "High-level general debate 22-26 and 28 September, mid NZ campaign" },
      { event: "COP31", place: "Antalya, Türkiye", startISO: "2026-11-09", endISO: "2026-11-20", note: "Under the COP30 Belém deal Türkiye hosts and formally presides; Australia holds the negotiations presidency; a pre-COP gathering is planned in the Pacific" },
      { event: "EAS-21: 21st East Asia Summit, with the 49th ASEAN Summit", place: "Manila, Philippines (2026 ASEAN chair)", startISO: "2026-11-10", endISO: "2026-11-12", note: "Philippine International Convention Center" },
      { event: "APEC 2026: 33rd Economic Leaders' Meeting", place: "Shenzhen, China", startISO: "2026-11-18", endISO: "2026-11-19", note: "Caps Leaders' Week; theme 'Building an Asia-Pacific community to prosper together'" },
    ],

    ftas: [
      { partner: "India", status: "Concluded 22 December 2025 after five negotiating rounds; signed in New Delhi 27 April 2026; not yet in force pending ratification and implementing legislation in both countries. Walters backed the legislation for Labour with caveats on what the deal excludes and the risk of tariffs returning in 15 years." },
      { partner: "Gulf Cooperation Council", status: "(unconfirmed) Negotiations concluded 31 October 2024; MFAT still lists the FTA as concluded but not in force as of August 2026, with formal signature pending and no entry-into-force date announced." },
      { partner: "UAE", status: "Comprehensive Economic Partnership Agreement signed 14 January 2025, in force since 28 August 2025; 98.5% of NZ goods exports enter the UAE duty-free." },
      { partner: "EU", status: "FTA signed 9 July 2023, in force since 1 May 2024; duties removed on 91% of NZ goods exports from day one, rising to 97% after seven years." },
      { partner: "CPTPP accessions", status: "UK accession in force for NZ since 15 December 2024 (progressively for others: Mexico from 22 June 2026, Canada from 1 September 2026). China's and Taiwan's September 2021 applications remain pending with no accession working groups established; the November 2025 Commission commenced a process only for Uruguay, with the UAE, Philippines and Indonesia possibly to follow in 2026." },
    ],

    defence: {
      dcp: "2025 Defence Capability Plan (released 7 April 2025): $12 billion of defence investment over four years, including $9 billion of new spending, on a path toward roughly 2% of GDP; still the Government's operative defence investment blueprint in 2026, though an April 2026 NZ Initiative report warned delivery needs institutional reform.",
      budget2026: "Budget 2026 (delivered 28 May 2026): headline $1.58 billion defence uplift, $880 million operating and $700 million capital, focused on maritime security, drones, ship maintenance and Defence Capability Plan projects; lifts the annual defence budget to about NZ$6.2 billion, with defence and intelligence agencies spared from wider cuts as spending tracks toward 2% of GDP.",
      aukus: "As of May 2026 New Zealand remains in a holding pattern on AUKUS Pillar 2: Foreign Minister Winston Peters' office says NZ is awaiting advice from AUKUS partners on how Pillar 2 will progress following the US review of the pact (completed December 2025, focused on Pillar 1), while continuing a 'deliberate and considered approach' to exploring potential non-nuclear participation, with no decision made and no NZDF participation in Pillar 2 activities to date.",
    },

    pacificBilaterals: [
      { country: "Cook Islands", line: "The row over PM Mark Brown's February 2025 comprehensive strategic partnership with China, which led NZ to pause roughly NZ$30 million of development funding across two financial years, was resolved on 2 April 2026 when the two governments signed a Defence and Security Declaration requiring timely, transparent consultation with Wellington on security matters; Peters said the paused funding would be 'normalised' and described the China agreements as now having 'massive limitations'.", asOf: "2026-04-02" },
      { country: "Kiribati", line: "The aid review NZ launched in January 2025 after President Maamau cancelled a meeting with Peters ended without cuts, and ties have warmed: Peters signed a new NZ-Kiribati Statement of Partnership with Vice-President Teuea Toatu in Tarawa in January 2026, with NZ's long-standing development support continuing.", asOf: "2026-01" },
      { country: "Solomon Islands", line: "Under new PM Matthew Wale (elected 15 May 2026 after a no-confidence vote ousted Jeremiah Manele), Honiara says the 2022 China security pact must remain secret because of a legally binding confidentiality clause even as cabinet continues reviewing it; Wale used June 2026 visits to Australia and NZ (meeting Luxon and Peters) to reassure traditional partners the Solomons 'will not be the source of uncertainty and instability' on regional security.", asOf: "2026-06-12" },
      { country: "Papua New Guinea", line: "Close: a refreshed Statement of Partnership 2025-2029 and Luxon's September 2025 visit for PNG's 50th anniversary of independence; NZ hosts the Mateparae-moderated Burnham talks on Bougainville, where leaders have committed to declaring independence on 1 September 2027, but PNG's parliament has still not ratified the 97.7% 2019 referendum result, and in June 2026 the Bougainville government accused Port Moresby of breaching the Melanesian Agreement over a sessional order on ratification.", asOf: "2026-06-18" },
      { country: "New Caledonia", line: "(unconfirmed) NZ's post-unrest position is support for recovery and a peaceful, French-led dialogue on the institutional future: Peters visited Nouméa in May 2025 to back the Valls-led talks and warn against foreign interference, after signing an updated Joint Cooperation Plan in late 2024. The July 2025 Bougival Accord process has stalled amid FLNKS rejection and an indefinitely delayed local referendum; no 2026 NZ government statement updating this stance was found.", asOf: "2025-05-02" },
      { country: "Samoa", line: "FAST under La'auli Leuatea Schmidt won the 29 August 2025 snap election in a landslide (Fiame Naomi Mata'afa's new Samoa Uniting Party won only three seats) and the relationship is warm: PM Schmidt met Luxon in Wellington on 22 July 2026, reaffirming the partnership, discussing RSE labour mobility and trade, and confirming officials have begun scoping a modernisation of the 1962 Treaty of Friendship, with further talks to follow NZ's general election.", asOf: "2026-07-22" },
      { country: "Tuvalu", line: "The Australia-Tuvalu Falepili Union (2023) now functions as a precedent NZ is following: when Luxon met PM Feleti Teo in Auckland in March 2026 the two governments signed an updated partnership agreement, NZ pledged $20 million, and the leaders agreed to work towards an eventual Falepili-style treaty by 2028 covering climate, security and mobility ties.", asOf: "2026-03" },
    ],

    pacificLeaders: [
      { country: "Fiji", name: "Sitiveni Rabuka", title: "Prime Minister", since: "December 2022 (national election expected late 2026 or early 2027)" },
      { country: "Samoa", name: "La'aulialemalietoa Leuatea Polata'ivao Fosi Schmidt (La'auli Leuatea Schmidt)", title: "Prime Minister, FAST leader", since: "16 September 2025" },
      { country: "Tonga", name: "Lord Fatafehi Fakafānua", title: "Prime Minister", since: "18 December 2025 (elected after the November 2025 general election, replacing 'Aisake Eke; Cabinet announced 5 January 2026)" },
      { country: "Vanuatu", name: "Jotham Napat", title: "Prime Minister, Leaders Party", since: "11 February 2025" },
      { country: "Papua New Guinea", name: "James Marape", title: "Prime Minister", since: "May 2019 (a May 2026 Supreme Court ruling upheld limits on repeat no-confidence motions)" },
      { country: "Solomon Islands", name: "Matthew Wale", title: "Prime Minister, Solomon Islands Democratic Party", since: "15 May 2026 (elected 26-22 after Jeremiah Manele was ousted in a 7 May no-confidence vote)" },
      { country: "Cook Islands", name: "Mark Brown", title: "Prime Minister", since: "October 2020" },
      { country: "Kiribati", name: "Taneti Maamau", title: "President (Te Beretitenti)", since: "2016 (third and final term after re-election October 2024)" },
      { country: "Tuvalu", name: "Feleti Penitala Teo", title: "Prime Minister", since: "26 February 2024" },
      { country: "Nauru (formally renamed the Republic of Naoero in 2026)", name: "David Adeang", title: "President", since: "October 2023 (re-elected unopposed 14 October 2025)" },
      { country: "Palau", name: "Surangel Whipps Jr.", title: "President", since: "January 2021; second term since January 2025" },
      { country: "Marshall Islands", name: "Hilda Heine", title: "President", since: "January 2024 (previously 2016-2020)" },
      { country: "Federated States of Micronesia", name: "Wesley W. Simina", title: "President", since: "May 2023" },
      { country: "New Caledonia", name: "Milakulo Tukumuli (Éveil Océanien)", title: "President of the Government", since: "Elected 31 July 2026 by the Congress after the 28 June provincial elections, succeeding Alcide Ponga; leads a pro-France-aligned 'governance pact' government with Christopher Gygès (Les Loyalistes) as vice-president, running a French-financed recovery from the May 2024 unrest (14 dead, over EUR 2.2 billion damage)" },
    ],

    intelligence: {
      nzsisDg: "Andrew Hampton, Director-General of Security (NZSIS chief executive), appointed for five years from 17 April 2023; in June 2026 fronted public warnings about Chinese intelligence targeting New Zealanders via job and networking sites.",
      gcsbDg: "Andrew Clark, Director-General of the GCSB since 30 October 2023; delivered the Bureau's statement to Parliament's Intelligence and Security Committee on 4 March 2026.",
      threatAssessment: "The latest public NZSIS threat assessment is 'New Zealand's Security Threat Environment 2025' (published 21 August 2025). Headline finding, in Hampton's words: 'Our threat environment is deteriorating and that has a direct impact on our safety and security', with foreign interference, espionage and online radicalisation of young people making this one of the most challenging national security environments of recent times. No 2026 edition had appeared as of early August 2026; a separate February 2026 update kept the national terrorism threat level unchanged ('possible' under revised language).",
      igis: "No standalone public IGIS inquiries are currently on foot. Inspector-General Brendan Horsley's Work Programme 2026-27 (June 2026) records reviews already underway: safeguards for under-18 'sensitive category' individuals in counter-terrorism investigations, NZSIS use of psychologists, GCSB approval of Five Eyes partner intelligence-sharing requests, disruption operations by both agencies, and concluding work on the agencies' Pacific activities; plus systematic monitoring of Ukraine and Middle East conflict-related intelligence sharing. A public summary of NZSIS/GCSB artificial-intelligence use was released 8 July 2026.",
    },

    world: [
      ["US", "President Donald Trump (Vice President JD Vance); Secretary of State Marco Rubio (sworn in 21 January 2025)"],
      ["Australia", "PM Anthony Albanese; Foreign Minister Penny Wong (since May 2022)"],
      ["UK", "PM Andy Burnham since 20 July 2026, after Keir Starmer resigned. Do not cite Starmer (or Sunak) as current PM"],
      ["China", "Foreign Minister Wang Yi"],
    ],

    /* Concise glossary an FA reader needs. `match` keys are lowercase and
       word-boundary matched by local.js to link terms into backgrounders. */
    glossary: [
      { term: "AUKUS Pillar 2", match: ["aukus"], def: "The non-nuclear technology-sharing tier of the Australia-UK-US pact (AI, cyber, hypersonics, undersea capabilities). NZ has explored non-nuclear participation but made no decision; Pillar 1 is the nuclear-submarine programme NZ cannot join under its nuclear-free law." },
      { term: "CPTPP", match: ["cptpp", "trans-pacific partnership"], def: "Comprehensive and Progressive Agreement for Trans-Pacific Partnership: the 12-member Pacific-rim trade pact NZ helped found. Accessions are decided by consensus of existing members." },
      { term: "PACER Plus", match: ["pacer plus", "pacer-plus"], def: "Regional trade and development agreement between NZ, Australia and Pacific island states, in force since 2020; pairs tariff commitments with development assistance." },
      { term: "Falepili Union", match: ["falepili"], def: "The 2023 Australia-Tuvalu treaty pairing a climate-mobility pathway with a security guarantee and an Australian say over Tuvalu's other security arrangements; now a template NZ has agreed to work toward with Tuvalu by 2028." },
      { term: "Blue Pacific / Boe Declaration", match: ["blue pacific", "boe declaration"], def: "Pacific Islands Forum framing: the 'Blue Pacific continent' asserts collective Pacific stewardship; the 2018 Boe Declaration names climate change the single greatest security threat and broadens security well beyond the military." },
      { term: "UNCLOS", match: ["unclos", "law of the sea"], def: "UN Convention on the Law of the Sea: governs maritime zones, EEZs and seabed rights; the basis for Pacific states' claims that maritime boundaries endure as seas rise." },
      { term: "ICJ vs ICC", match: ["icj", "icc", "international court of justice", "international criminal court"], def: "The International Court of Justice settles disputes between states and gives advisory opinions; the International Criminal Court prosecutes individuals for genocide, war crimes and crimes against humanity. Different courts, commonly confused." },
      { term: "Rules-based order", match: ["rules-based order", "rules based order"], def: "Shorthand for the post-1945 system of international law, institutions and norms. Small states like NZ rely on it because they cannot enforce outcomes by power." },
      { term: "Five Eyes", match: ["five eyes"], def: "The NZ-Australia-UK-US-Canada signals-intelligence alliance, NZ's deepest intelligence relationship." },
      { term: "IGIS", match: ["igis", "inspector-general of intelligence"], def: "Inspector-General of Intelligence and Security: the independent statutory reviewer of NZSIS and GCSB legality and propriety." },
      { term: "FADTC", match: ["fadtc", "foreign affairs, defence and trade"], def: "Parliament's Foreign Affairs, Defence and Trade Committee: examines treaties, conducts inquiries and scrutinises MFAT, NZDF and Defence estimates." },
      { term: "Caretaker convention", match: ["caretaker"], def: "The Cabinet Manual convention restraining a government from significant decisions or new international obligations once an election is called or its mandate is in doubt; such commitments are deferred or made in consultation with other parties." },
      { term: "RSE scheme", match: ["rse", "recognised seasonal employer"], def: "Recognised Seasonal Employer scheme: NZ's capped Pacific seasonal-labour programme, a standing bilateral issue with Pacific governments." },
      { term: "COFA states", match: ["cofa", "compact of free association", "compacts of free association"], def: "Palau, the Marshall Islands and the Federated States of Micronesia, bound to the US by Compacts of Free Association covering defence and funding." },
      { term: "Comprehensive Strategic Partnership", match: ["comprehensive strategic partnership"], def: "China's top-tier bilateral label. The Cook Islands' February 2025 CSP with Beijing triggered the row with Wellington resolved by the April 2026 NZ-Cook Islands defence and security declaration." },
    ],
  };

  function aiContext() {
    const D = DATA;
    const lines = [];
    lines.push("PRINCIPAL: " + D.principal.name + ", " + D.principal.role + ". " + D.principal.since + ". " +
      D.principal.seat + ". Background: " + D.principal.background + ". " + D.principal.associate + ". " + D.principal.isc + ".");
    lines.push("HER POSITIONS:");
    for (const p of D.positions) {
      lines.push("- " + p.line + (p.quote ? " Quote: \"" + p.quote + "\"" : "") + " (" + p.source + ", " + p.date + ")");
    }
    lines.push("GOVERNMENT FA POSTURE: " + D.government.coalition + " coalition. " +
      D.government.ministers.map((m) => m[0] + " (" + m[1] + "): " + m[2]).join("; ") + ". " + D.government.reshuffle);
    lines.push("LABOUR TEAM: " + D.labourTeam.map((m) => m[0] + ": " + m[1]).join("; ") + ".");
    lines.push("ELECTION FRAME: " + D.election.frame + " " + D.election.collision + " " + D.election.caretaker);
    lines.push("CALENDAR:");
    for (const c of D.calendar) {
      const span = c.endISO && c.endISO !== c.startISO ? c.startISO + " to " + c.endISO : c.startISO;
      lines.push("- " + c.event + ", " + c.place + ", " + span + (c.note ? ". " + c.note : ""));
    }
    lines.push("LIVE NEGOTIATIONS:");
    for (const f of D.ftas) lines.push("- " + f.partner + ": " + f.status);
    lines.push("DEFENCE & INTELLIGENCE:");
    lines.push("- " + D.defence.dcp);
    lines.push("- " + D.defence.budget2026);
    lines.push("- " + D.defence.aukus);
    lines.push("- " + D.intelligence.nzsisDg);
    lines.push("- " + D.intelligence.gcsbDg);
    lines.push("- " + D.intelligence.threatAssessment);
    lines.push("- " + D.intelligence.igis);
    lines.push("PACIFIC BILATERALS & LEADERS:");
    for (const b of D.pacificBilaterals) lines.push("- " + b.country + ": " + b.line + " (as of " + b.asOf + ")");
    lines.push("- Leaders: " + D.pacificLeaders.map((l) => l.country + ": " + l.name + " (" + l.title + ", since " + l.since + ")").join("; ") + ".");
    lines.push("WORLD OFFICEHOLDERS: " + D.world.map((w) => w[0] + ": " + w[1]).join("; ") + ".");
    lines.push("(Context verified " + D.verifiedAsOf + "; for anything after that date rely on the supplied wire items.)");
    return lines.join("\n");
  }

  window.FADATA = { data: DATA, aiContext };
})();
