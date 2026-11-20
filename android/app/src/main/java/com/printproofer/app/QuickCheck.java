package com.printproofer.app;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fast offline checks run in the background on new screenshots (no app UI open), to decide
 * whether to send a "possible mistakes" notification. The full check runs when it's tapped.
 * Mirrors the most reliable rules of src/offline.ts.
 */
public final class QuickCheck {
    private QuickCheck() {}

    private static final String[] DAYS = {"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"};
    private static final String[] MONTHS = {"january", "february", "march", "april", "may", "june", "july", "august",
        "september", "october", "november", "december"};

    private static final Map<String, String> COMMON = new HashMap<>();
    static {
        String[] pairs = {
            "suprise", "surprise", "recieve", "receive", "seperate", "separate", "definately", "definitely",
            "occured", "occurred", "accomodate", "accommodate", "untill", "until", "wierd", "weird",
            "tommorow", "tomorrow", "calender", "calendar", "resturant", "restaurant", "restaraunt", "restaurant",
            "guarentee", "guarantee", "adress", "address", "buisness", "business", "bussiness", "business",
            "comming", "coming", "begining", "beginning", "beleive", "believe", "neccessary", "necessary",
            "occassion", "occasion", "sucess", "success", "truely", "truly", "writting", "writing",
            "reccomend", "recommend", "recomend", "recommend", "febuary", "February", "wensday", "Wednesday",
            "thier", "their", "greatful", "grateful", "reciept", "receipt", "enviroment", "environment",
            "goverment", "government", "immediatly", "immediately", "jewelery", "jewelry", "lisence", "license",
            "prefered", "preferred", "experiance", "experience", "excellant", "excellent", "finaly", "finally",
            "realy", "really", "remeber", "remember", "scedule", "schedule", "shedule", "schedule",
            "succesful", "successful", "successfull", "successful", "teh", "the", "wich", "which",
            "openning", "opening", "anual", "annual", "aniversary", "anniversary", "availible", "available",
            "comittee", "committee", "convienient", "convenient", "delicous", "delicious", "freind", "friend",
            "garantee", "guarantee", "independant", "independent", "minature", "miniature", "oppurtunity", "opportunity",
            "persue", "pursue", "pasttime", "pastime", "speach", "speech", "tempature", "temperature",
            "coffe", "coffee", "pastrys", "pastries",
        };
        for (int i = 0; i < pairs.length; i += 2) COMMON.put(pairs[i], pairs[i + 1]);
    }

    public static List<String> check(String text) {
        List<String> out = new ArrayList<>();
        if (text == null || text.trim().split("\\s+").length < 4) return out;

        // Misspellings
        Matcher w = Pattern.compile("\\b[A-Za-z]{3,}\\b").matcher(text);
        while (w.find() && out.size() < 6) {
            String fix = COMMON.get(w.group().toLowerCase(Locale.US));
            if (fix != null) add(out, "“" + w.group() + "” → “" + fix + "”");
        }
        // Doubled words
        Matcher d = Pattern.compile("\\b([A-Za-z]{2,})\\s+\\1\\b", Pattern.CASE_INSENSITIVE).matcher(text);
        while (d.find()) {
            String x = d.group(1).toLowerCase(Locale.US);
            if (!x.equals("that") && !x.equals("had") && !x.equals("bye") && !x.equals("no") && !x.equals("so") && !x.equals("very")) {
                add(out, "Repeated word: “" + d.group() + "”");
            }
        }
        // Weekday vs date: "Friday, December 5, 2026" / "Fri Dec 5"
        Matcher m = Pattern.compile("\\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\\.?,?\\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?", Pattern.CASE_INSENSITIVE).matcher(text);
        while (m.find()) {
            int dow = indexOf(DAYS, m.group(1));
            int month = indexOf(MONTHS, m.group(2));
            int day = Integer.parseInt(m.group(3));
            Calendar now = Calendar.getInstance();
            int year = m.group(4) != null ? Integer.parseInt(m.group(4)) : now.get(Calendar.YEAR);
            if (m.group(4) == null) {
                Calendar guess = Calendar.getInstance();
                guess.set(year, month, day);
                if (guess.getTimeInMillis() < now.getTimeInMillis() - 60L * 86400000L) year++;
            }
            Calendar c = Calendar.getInstance();
            c.setLenient(false);
            c.clear();
            try {
                c.set(year, month, day);
                int actual = c.get(Calendar.DAY_OF_WEEK) - 1;
                if (actual != dow) {
                    add(out, "“" + m.group().trim() + "”: that date is a " + cap(DAYS[actual]));
                }
            } catch (Exception e) {
                add(out, "“" + m.group().trim() + "”: that date doesn't exist");
            }
        }
        // Phone numbers with the wrong number of digits
        Matcher p = Pattern.compile("(?:\\+?1[\\s.-])?\\(?\\d{3}\\)?[\\s.-]\\d{3}[\\s.-]\\d{2,6}\\b").matcher(text);
        while (p.find()) {
            String digits = p.group().replaceAll("\\D", "");
            int n = digits.length() == 11 && digits.startsWith("1") ? 10 : digits.length();
            if (n != 10) add(out, "Phone “" + p.group().trim() + "” has " + n + " digits");
        }
        // Emails missing their ending
        Matcher e = Pattern.compile("[\\w.+-]+@[\\w.-]*").matcher(text);
        while (e.find()) {
            String addr = e.group().replaceAll("[.,;:]+$", "");
            if (!addr.matches("[\\w.+-]+@[\\w-]+(\\.[\\w-]+)*\\.[A-Za-z]{2,}")) add(out, "Email “" + addr + "” looks incomplete");
        }
        // UPC / EAN check digits
        Matcher u = Pattern.compile("(?<![\\d-])\\d(?:[ ]?\\d){11,12}(?![\\d-])").matcher(text);
        while (u.find()) {
            String digits = u.group().replaceAll("\\D", "");
            if ((digits.length() == 12 || digits.length() == 13) && !gs1Valid(digits)) add(out, "Product number " + u.group() + " has a wrong check digit");
        }
        // “Their is”
        Matcher t = Pattern.compile("\\b(their|they're) (is|are|was|were)\\b", Pattern.CASE_INSENSITIVE).matcher(text);
        while (t.find()) add(out, "“" + t.group() + "” → “there " + t.group(2) + "”");
        return out;
    }

    static boolean gs1Valid(String d) {
        int sum = 0;
        for (int i = d.length() - 2, k = 0; i >= 0; i--, k++) sum += (d.charAt(i) - '0') * (k % 2 == 0 ? 3 : 1);
        return (10 - sum % 10) % 10 == d.charAt(d.length() - 1) - '0';
    }

    private static void add(List<String> out, String s) {
        if (!out.contains(s)) out.add(s);
    }

    private static int indexOf(String[] arr, String prefix) {
        String p = prefix.toLowerCase(Locale.US).substring(0, 3);
        for (int i = 0; i < arr.length; i++) if (arr[i].startsWith(p)) return i;
        return 0;
    }

    private static String cap(String s) {
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }
}
