from itertools import product
import json


def eval_sop(bits, terms):
    vals = dict(zip("ABCD", bits))
    out = 0
    for term in terms:
        t = 1
        for name, neg in term:
            v = vals[name]
            if neg:
                v = 1 - v
            t &= v
        out |= t
    return out


def minterms(terms):
    return {
        i
        for i, bits in enumerate(product([0, 1], repeat=4))
        if eval_sop(bits, terms)
    }


def eq(a, b):
    return all(eval_sop(bits, a) == eval_sop(bits, b) for bits in product([0, 1], repeat=4))


def stats(terms):
    return {"term_count": len(terms), "literal_count": sum(len(t) for t in terms)}


def term_str(terms):
    out = ""
    for name, neg in terms:
        out += name + ("̅" if neg else "")
    return out or "1"


def check():
    # Q-065 2.13(a), independently transcribed from verified textbook P56.
    q_terms = [
        [("A", False), ("B", True), ("C", True)],
        [("A", False), ("B", True), ("C", False)],
        [("A", True), ("B", False), ("C", False)],
        [("A", True), ("B", False), ("C", True), ("D", False)],
        [("A", False), ("B", False), ("D", True)],
    ]
    q_min = [
        [("A", True), ("B", False)],
        [("A", False), ("B", True)],
        [("A", True), ("B", True), ("D", True)],
        [("A", False), ("B", False), ("D", True)],
    ]
    practice = [
        [("A", True), ("B", False)],
        [("A", False), ("B", True), ("D", True)],
    ]
    return {
        "unit": "KU-033",
        "checks": [
            {
                "claim": "Q-065 2.13(a) simplifies to A B̄ + ĀB + AB D + ĀB̄D",
                "onset": sorted(minterms(q_terms)),
                "original": "+".join(term_str(t) for t in q_terms),
                "minimal": "+".join(term_str(t) for t in q_min),
                "equivalent": eq(q_terms, q_min),
                "minimal_stats": stats(q_min),
                "passed": eq(q_terms, q_min) and stats(q_min) == {"term_count": 4, "literal_count": 10},
            },
            {
                "claim": "practice F=A B̄ + ĀB D",
                "onset": sorted(minterms(practice)),
                "expression": "+".join(term_str(t) for t in practice),
                "stats": stats(practice),
                "passed": stats(practice) == {"term_count": 2, "literal_count": 5},
            },
        ],
        "passed": eq(q_terms, q_min)
        and stats(q_min) == {"term_count": 4, "literal_count": 10}
        and stats(practice) == {"term_count": 2, "literal_count": 5},
    }


if __name__ == "__main__":
    print(json.dumps(check(), ensure_ascii=False, indent=2))
