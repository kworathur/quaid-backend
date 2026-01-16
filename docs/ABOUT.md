# Quaid REST API 


Quaid (a portmanteau of "Quicker (Financial) Aid") was created to combat fraud in financial aid and admissions applications, accelerating financial aid payout to legitimate students by filtering out bad actors in an automated fashion. 


The background checks service is hosted as a REST api at `https://quaid.ai/api/v1`. 

## Description of API routes

/api/v1/students

POST

* Creates a new student. The new student is assigned a status of UNVERIFIED until they have verified their email address. Any applications submitted for the student will be placed on hold until the student has verified their email address.
* Required fields: First name, last name, email address, date of birth
* Response: 200 if all required fields are present and valid, 400 if there are missing fields or validation errors

GET

* Returns a list of all students in the application 
* Authentication: caller must be an admin user
* Response: paginated list of students in the application

DELETE

* Remove a student from the system (graduation, withdrawn application)
* Authentication: caller must be an admin user