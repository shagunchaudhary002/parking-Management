/* Parking Booking */

function bookSlot(button) {

    let slot = button.closest(".slot");

    let slotName = slot.querySelector("small").innerText;

    let confirmBooking = confirm(
        "Do you want to book parking slot " + slotName + "?"
    );

    if (confirmBooking == false) {
        return;
    }

    slot.classList.remove("available-slot");
    slot.classList.add("reserved-slot");

    let status = slot.querySelector(".slot-top span");

    status.innerText = "Reserved";

    button.innerText = "Reserved";

    button.disabled = true;

    updateParkingCount();

    alert("Parking slot " + slotName + " has been booked.");
}


/* Update Parking Numbers */

function updateParkingCount() {

    let available =
        document.querySelectorAll(".available-slot").length;

    let reserved =
        document.querySelectorAll(".reserved-slot").length;

    document.getElementById("availableCount").innerText =
        available;

    document.getElementById("reservedCount").innerText =
        reserved;
}


/* Scroll Animation */

function revealElements() {

    let elements =
        document.querySelectorAll(".reveal");

    elements.forEach(function(element) {

        let position =
            element.getBoundingClientRect().top;

        let screenHeight =
            window.innerHeight;

        if (position < screenHeight - 80) {

            element.classList.add("show");

        }

    });
}

window.addEventListener("scroll", revealElements);

window.addEventListener("load", revealElements);


/* Statistics Counter */

let countersStarted = false;

function startCounters() {

    if (countersStarted) {
        return;
    }

    let statistics =
        document.querySelector(".statistics");

    let position =
        statistics.getBoundingClientRect().top;

    if (position < window.innerHeight - 100) {

        countersStarted = true;

        let counters =
            document.querySelectorAll("[data-target]");

        counters.forEach(function(counter) {

            let target =
                Number(counter.getAttribute("data-target"));

            let number = 0;

            let interval =
                setInterval(function() {

                    number++;

                    counter.innerText = number;

                    if (number >= target) {

                        clearInterval(interval);

                    }

                }, 25);

        });

    }
}

window.addEventListener("scroll", startCounters);


/* Contact Form */

function sendMessage(event) {

    event.preventDefault();

    alert("Your message has been sent successfully.");

    event.target.reset();
}